import { describe, expect, it, vi } from 'vitest';
import {
    ActionInputFieldHintSchema,
    QualifiedConnectedAccountRefSchema,
    type EffectiveActionInputField,
} from '@happier-dev/protocol';
import { findTestInstanceByTypeContainingText, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installSessionActionsCommonModuleMocks } from './sessionActionsTestHelpers';

installSessionActionsCommonModuleMocks();

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

describe('ActionInputFields', () => {
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

        const claudeChip = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Claude');
        const codexChip = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Codex');
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
            .find((node) => node.props.accessibilityRole === 'switch');
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
        expect(webhook?.props.accessibilityRole).toBe('radio');
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

        const workAccount = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Work account');
        await pressTestInstanceAsync(workAccount);

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

        const workAccount = findTestInstanceByTypeContainingText(
            screen.tree,
            'Pressable',
            ['Work account', 'Connected through Acme'],
        );
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
