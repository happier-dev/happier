import { describe, expect, it, vi } from 'vitest';
import {
    InputFieldHintSchema as ActionInputFieldHintSchema} from '@happier-dev/protocol/inputs/inputFields';
import {
    QualifiedConnectedAccountRefSchema} from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import {
    type EffectiveInputField as EffectiveActionInputField,
    resolveEffectiveInputFields as resolveEffectiveActionInputFields,
} from '@happier-dev/protocol/inputs/inputFieldRuntime';
import {
    getActionSpec} from '@happier-dev/protocol/actions/actionSpecs';
import { findTestInstanceByTypeContainingText, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installSessionActionsCommonModuleMocks } from './sessionActionsTestHelpers';

installSessionActionsCommonModuleMocks();
const { ActionInputFields } = await import('./ActionInputFields');

function effectiveField(
    field: unknown,
    state: Partial<Pick<EffectiveActionInputField, 'visible' | 'required' | 'disabled'>> = {},
): EffectiveActionInputField {
    const parsed = ActionInputFieldHintSchema.parse(field);
    return {
        ...parsed,
        visible: state.visible ?? true,
        required: state.required ?? (parsed.required === true),
        disabled: state.disabled ?? false,
    };
}


/** The compact choice field names its reading and opens its rows in place; open it, then find a row by label. */
async function openChoices(screen: Awaited<ReturnType<typeof renderScreen>>, title: string) {
    const trigger = screen.findAllByType('Pressable').find(node => String(node.props.accessibilityLabel ?? '').startsWith(`${title}:`));
    expect(trigger).toBeDefined();
    await pressTestInstanceAsync(trigger);
}
const choiceRow = (screen: Awaited<ReturnType<typeof renderScreen>>, label: string) => screen.findAllByType('Pressable')
    .find(node => {
        const role = node.props.role ?? node.props.accessibilityRole;
        return (role === 'checkbox' || role === 'radio')
            && String(node.props.accessibilityLabel ?? '').startsWith(label);
    });

// The field's choices float in the host's Popover; render it in place so the real rows are driven.
vi.mock('@/components/ui/popover/Popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal as never) as never);
describe('ActionInputFields', () => {
    it('keeps an absent choice distinct from an unavailable saved choice', async () => {
        const { formatActionInputFieldChoice } = await import('./ActionInputFields');
        const field = effectiveField({ path: 'profileId', title: 'Profile', widget: 'select', optionsSourceId: 'browser.profiles.available' });
        expect(formatActionInputFieldChoice(field, null, () => [])).toBeNull();
        expect(formatActionInputFieldChoice(field, '', () => [])).toBeNull();
        expect(formatActionInputFieldChoice(field, 'missing-definition', () => [])).not.toBeNull();
        expect(formatActionInputFieldChoice(field, null, () => [{ value: null, label: 'Use default' }])).toBe('Use default');
    });

    it('holds a dependent choice field closed until the field it reads from is chosen, without a failure line', async () => {
        const machine = effectiveField({ path: 'machineId', title: 'Machine', widget: 'select', optionsSourceId: 'sessions.spawn.machines.available' });
        const profile = effectiveField({ path: 'profileId', title: 'Browser profile', widget: 'select',
            optionsSourceId: 'browser.profiles.available', allowCustomValue: true });
        const resolveFieldOptions = Object.assign((field: { optionsSourceId?: string }) =>
            field.optionsSourceId === 'sessions.spawn.machines.available' ? [{ value: 'm1', label: 'Build box' }] : [], {
            state: (field: { optionsSourceId?: string }) => field.optionsSourceId === 'browser.profiles.available'
                ? { status: 'failed' as const, options: [], errorCode: 'missing_option_dependency', requiredDraftPath: 'machineId' }
                : { status: 'ready' as const, options: [{ value: 'm1', label: 'Build box' }] },
            retry: vi.fn(),
        });
        const screen = await renderScreen(<ActionInputFields fields={[machine, profile]} input={{}} editable
            resolveFieldOptions={resolveFieldOptions} onPatch={vi.fn()} />);
        const trigger = screen.findAllByType('Pressable').find(node => String(node.props.accessibilityLabel ?? '').startsWith('Browser profile:'));
        expect(trigger?.props.accessibilityLabel).toBe('Browser profile: workflows.start.choicesNeedField');
        expect(trigger?.props.disabled).toBe(true);
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'workflows.start.choicesFailed')).toBeFalsy();
    });

    it('writes a new Browser profile name from the shared suggested-choice control', async () => {
        const field = effectiveField({ path: 'profileId', title: 'Profile', widget: 'select',
            optionsSourceId: 'browser.profiles.available', allowCustomValue: true });
        const onPatch = vi.fn();
        const screen = await renderScreen(<ActionInputFields fields={[field]} input={{ profileId: 'work' }} editable
            resolveFieldOptions={() => [{ value: 'work', label: 'Work' }, { value: 'personal', label: 'Personal' }]}
            resolveFieldTestID={() => 'profile-name'} onPatch={onPatch} />);
        await openChoices(screen, 'Profile');
        screen.changeTextByTestId('profile-name', 'new-profile');
        expect(onPatch).toHaveBeenCalledWith({ profileId: 'new-profile' });
    });
    it('chooses Software without replacing prepared target arrays or their other items', async () => {
        const current = { pluginId: 'fixture.software', recipeId: 'fonts', revision: '1' };
        const chosen = { ...current, recipeId: 'ffmpeg' };
        const item = { kind: 'softwareRecipe', selection: { ref: current, inputs: {} } };
        const first = { homeId: 'home', machineId: 'first', desiredRevision: 0, recipePlans: [],
            sources: [{ kind: 'direct', setup: { items: [item, item] } }] };
        const second = { ...first, machineId: 'second' };
        const input = { homeId: 'home', machineId: 'host', targets: [first, second] };
        const spec = getActionSpec('machines.setup.apply');
        const fields = resolveEffectiveActionInputFields(spec, input)
            .filter(field => field.optionsSourceId === 'machines.setup.software.available');
        const onPatch = vi.fn();
        const screen = await renderScreen(<ActionInputFields fields={fields} input={input} editable
            resolveFieldOptions={() => [{ value: current, label: 'Fonts' }, { value: chosen, label: 'FFmpeg' }]}
            onPatch={onPatch} />);
        await pressTestInstanceAsync(choiceRow(screen, 'FFmpeg'));
        expect(onPatch).toHaveBeenCalledTimes(1);
        const changed = { ...input, ...onPatch.mock.calls[0]?.[0] };
        expect(spec.inputSchema.safeParse(changed).success).toBe(true);
        expect(changed.targets).toEqual([{ ...first, sources: [{ ...first.sources[0], setup: {
            items: [{ ...item, selection: { ...item.selection, ref: chosen } }, item],
        } }] }, second]);
        expect(changed.targets[1]).toBe(second);
        expect(changed.targets[0]?.sources[0]?.setup.items[1]).toBe(item);
        expect(input.targets[0]?.sources[0]?.setup.items[0]).toBe(item);
    });
    it('retains one array-valued group choice and writes its replacement as one choice', async () => {
        const { ActionInputFields } = await import('./ActionInputFields');
        const onPatch = vi.fn();
        const screen = await renderScreen(<ActionInputFields
            fields={[effectiveField({ path: 'breakdown', title: 'Group by', widget: 'select', optionsSourceId: 'usage.query.breakdown' })]}
            input={{ breakdown: ['source', 'machine'] }}
            editable
            resolveFieldOptions={() => [
                { value: ['source', 'machine'], label: 'Saved group' },
                { value: ['model'], label: 'Model' },
            ]}
            getChipAccessibilityLabel={({ option, selected }) => `${option.label}: ${selected ? 'selected' : 'unselected'}`}
            onPatch={onPatch}
        />);
        const saved = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Saved group');
        expect(saved?.props.accessibilityLabel).toBe('Saved group: selected');
        expect(saved?.props.accessibilityState?.checked).toBe(true);
        await pressTestInstanceAsync(findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Model'));
        expect(onPatch).toHaveBeenCalledWith({ breakdown: ['model'] });
    });

    it('presents a declared setup question without replacing its noun or changing the submitted value', async () => {
        const { ActionInputFields } = await import('./ActionInputFields');
        const field = effectiveField({ path: 'project', title: 'Project', prompt: 'Which project?', widget: 'text' });
        const onPatch = vi.fn();
        const screen = await renderScreen(<ActionInputFields fields={[field]} input={{ project: 'chosen' }}
            editable resolveFieldOptions={() => []} resolveFieldTestID={() => 'setup-project'} onPatch={onPatch} />);
        const input = screen.findAllByType('TextInput').find(node => node.props.accessibilityLabel === 'Which project?');
        expect(input).toBeDefined();
        expect(field.title).toBe('Project');
        screen.changeTextByTestId('setup-project', 'next');
        expect(onPatch).toHaveBeenCalledWith({ project: 'next' });
    });
    it('does not clear the last selected value for required multiselect fields', async () => {
        const { ActionInputFields } = await import('./ActionInputFields');
        const onPatch = vi.fn();

        const screen = await renderScreen(<ActionInputFields
            fields={[
                effectiveField({
                    path: 'engineIds',
                    title: 'Review engines',
                    widget: 'multiselect',
                    required: true,
                    optionsSourceId: 'test.reviewEngines',
                }),
            ]}
            input={{ engineIds: ['claude'] }}
            editable
            resolveFieldOptions={() => [
                { value: 'claude', label: 'Claude' },
                { value: 'codex', label: 'Codex' },
            ]}
            onPatch={onPatch}
        />);

        const claudeChip = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Claude');
        expect(claudeChip).toBeDefined();

        await pressTestInstanceAsync(claudeChip);

        expect(onPatch).not.toHaveBeenCalled();
    });

    it('atomically replaces a required max-one multiselect selection with the latest pressed option', async () => {
        const { ActionInputFields } = await import('./ActionInputFields');
        const onPatch = vi.fn();

        const screen = await renderScreen(<ActionInputFields
            fields={[effectiveField({
                path: 'engineIds',
                title: 'Review engines',
                widget: 'multiselect',
                required: true,
                maxSelections: 1,
                optionsSourceId: 'test.reviewEngines',
            })]}
            input={{ engineIds: ['claude'] }}
            editable
            resolveFieldOptions={() => [
                { value: 'claude', label: 'Claude' },
                { value: 'codex', label: 'Codex' },
            ]}
            onPatch={onPatch}
        />);

        await openChoices(screen, 'Review engines');
        const claudeChip = choiceRow(screen, 'Claude');
        const codexChip = choiceRow(screen, 'Codex');
        expect(claudeChip?.props.disabled).toBe(true);
        expect(codexChip?.props.disabled).not.toBe(true);

        await pressTestInstanceAsync(codexChip);

        expect(onPatch).toHaveBeenCalledWith({ engineIds: ['codex'] });
    });

    it('renders the canonical boolean widget and patches an actual boolean value', async () => {
        const { ActionInputFields } = await import('./ActionInputFields');
        const onPatch = vi.fn();

        const screen = await renderScreen(<ActionInputFields
            fields={[effectiveField({
                path: 'includeArchived',
                title: 'Include archived',
                widget: 'boolean',
            })]}
            input={{ includeArchived: false }}
            editable
            resolveFieldOptions={() => []}
            onPatch={onPatch}
        />);

        const enabled = screen.findAllByType('Pressable')
            .find((node) => (node.props.role ?? node.props.accessibilityRole) === 'switch');
        expect(enabled).toBeDefined();

        await pressTestInstanceAsync(enabled);

        expect(onPatch).toHaveBeenCalledWith({ includeArchived: true });
    });

    it('presents a single-select field as one radiogroup with radio options', async () => {
        const { ActionInputFields } = await import('./ActionInputFields');

        const screen = await renderScreen(<ActionInputFields
            fields={[effectiveField({
                path: 'mode',
                title: 'Connection mode',
                widget: 'select',
                optionsSourceId: 'test.connectionMode',
            })]}
            input={{ mode: 'poll' }}
            editable
            resolveFieldOptions={() => [
                { value: 'poll', label: 'Polling' },
                { value: 'webhook', label: 'Webhook' },
            ]}
            onPatch={() => undefined}
        />);

        const radioGroup = screen.findAllByType('View')
            .find((node) => node.props.role === 'radiogroup' && node.props.accessibilityLabel === 'Connection mode');
        const webhook = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Webhook');

        expect(radioGroup).toBeDefined();
        expect(webhook?.props.role ?? webhook?.props.accessibilityRole).toBe('radio');
    });

    it('compares selected Connected Account refs semantically and preserves the exact selected value', async () => {
        const { ActionInputFields } = await import('./ActionInputFields');
        const onPatch = vi.fn();
        const account = QualifiedConnectedAccountRefSchema.parse({
            service: { pluginId: 'com.acme.accounts', localId: 'service' },
            accountId: 'account-1',
        });
        const screen = await renderScreen(<ActionInputFields
            fields={[effectiveField({
                path: 'credentialRefs',
                title: 'Accounts',
                widget: 'multiselect',
                optionsSourceId: 'test.connectedAccounts',
            })]}
            input={{ credentialRefs: [{ ...account, service: { ...account.service } }] }}
            editable
            resolveFieldOptions={() => [{ value: account, label: 'Work account' }]}
            onPatch={onPatch}
        />);

        await openChoices(screen, 'Accounts');
        await pressTestInstanceAsync(choiceRow(screen, 'Work account'));

        expect(onPatch).toHaveBeenCalledWith({ credentialRefs: [] });
    });

    it('selects an unselected Connected Account ref exactly and renders its safe option description', async () => {
        const { ActionInputFields } = await import('./ActionInputFields');
        const onPatch = vi.fn();
        const account = QualifiedConnectedAccountRefSchema.parse({
            service: { pluginId: 'com.acme.accounts', localId: 'service' },
            accountId: 'account-2',
        });
        const screen = await renderScreen(<ActionInputFields
            fields={[effectiveField({
                path: 'credentialRef',
                title: 'Account',
                widget: 'select',
                connectedAccountOptions: true,
            })]}
            input={{}}
            editable
            resolveFieldOptions={() => [{
                value: account,
                label: 'Work account',
                description: 'Connected through Acme',
            }]}
            onPatch={onPatch}
        />);

        await openChoices(screen, 'Account');
        const workAccount = choiceRow(screen, 'Work account: Connected through Acme');
        expect(workAccount).toBeDefined();

        await pressTestInstanceAsync(workAccount);

        expect(onPatch).toHaveBeenCalledWith({ credentialRef: account });
    });

    it('projects secret, URL, and numeric widgets through the shared text-field owner', async () => {
        const { ActionInputFields } = await import('./ActionInputFields');
        const onPatch = vi.fn();
        const screen = await renderScreen(<ActionInputFields
            fields={[
                effectiveField({ path: 'token', title: 'Token', widget: 'secret' }),
                effectiveField({ path: 'endpoint', title: 'Endpoint', widget: 'url' }),
                effectiveField({ path: 'limit', title: 'Limit', widget: 'integer' }),
            ]}
            input={{ token: 'hidden', endpoint: 'https://example.test', limit: 2 }}
            editable
            resolveFieldOptions={() => []}
            resolveFieldTestID={(field) => `action-field-${field.path}`}
            onPatch={onPatch}
        />);

        const inputs = screen.findAllByType('TextInput');
        expect(inputs).toHaveLength(3);
        expect(inputs[0]?.props.secureTextEntry).toBe(true);
        expect(inputs[1]?.props.keyboardType).toBe('url');
        expect(inputs[2]?.props.keyboardType).toBe('numeric');

        screen.changeTextByTestId('action-field-limit', '7');
        expect(onPatch).toHaveBeenCalledWith({ limit: 7 });
    });

    it('projects field descriptions and text placeholders through the shared host form', async () => {
        const { ActionInputFields } = await import('./ActionInputFields');
        const endpointDescription = 'Use a reachable HTTPS endpoint.';
        const transportDescription = 'Choose how this connection receives events.';
        const enabledDescription = 'Deliver matching events while this connection is enabled.';
        const endpointPlaceholder = 'https://example.com/webhook';

        const screen = await renderScreen(<ActionInputFields
            fields={[
                effectiveField({
                    path: 'endpoint',
                    title: 'Webhook endpoint',
                    description: endpointDescription,
                    placeholder: endpointPlaceholder,
                    widget: 'url',
                }),
                effectiveField({
                    path: 'transport',
                    title: 'Transport',
                    description: transportDescription,
                    widget: 'select',
                    optionsSourceId: 'test.transport',
                }),
                effectiveField({
                    path: 'enabled',
                    title: 'Enabled',
                    description: enabledDescription,
                    widget: 'boolean',
                }),
            ]}
            input={{ endpoint: '', transport: 'webhook', enabled: true }}
            editable
            resolveFieldOptions={() => [
                { value: 'webhook', label: 'Webhook' },
                { value: 'poll', label: 'Polling' },
            ]}
            onPatch={() => undefined}
        />);

        const inputs = screen.findAllByType('TextInput');
        expect({
            descriptions: [
                endpointDescription,
                transportDescription,
                enabledDescription,
            ].map((description) => Boolean(
                findTestInstanceByTypeContainingText(screen.tree, 'Text', description),
            )),
            placeholder: inputs[0]?.props.placeholder,
        }).toEqual({
            descriptions: [true, true, true],
            placeholder: endpointPlaceholder,
        });
    });
});
