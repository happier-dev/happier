import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { HappierInputPickerProvider, HappierValidationMessage } from '@happier-dev/plugin-ui/presentation';
import type { ResolvedInputTypeV1 } from '@happier-dev/protocol/inputs/runtime';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createInputTypePickerPort } from '@/components/sessions/actions/inputTypePickerPort';
import { selectBuiltinWidgetCandidates } from '@/components/widgets/widgetCatalog';
import { buildWidgetCandidateSetup } from '@/components/widgets/surface/widgetSurfaceSetup';
import { describeWidgetSetupRow, setWidgetSetupBinding } from './widgetSetupModel';

import {
    repositoryInputTypeRef,
    repositoryInputTypes,
} from '../../../../../../packages/plugin-sdk/examples/public-authoring/inputTypes';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { WidgetSetupFieldRow, type WidgetSetupFieldChange } from './WidgetSetupFieldRow';
import type { WidgetSetupField } from './widgetSetupModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The field's choices float in the host's Popover; render it in place so the real rows are driven.
vi.mock('@/components/ui/popover/Popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal as never) as never);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));

afterEach(() => { standardCleanup(); });

/** The strings the binding control draws (its value, then the quieter second half). */
function bindingText(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string): string[] {
    const trigger = screen.findByTestId(`${testID}.trigger`);
    if (!trigger) throw new Error(`no binding trigger ${testID}`);
    return trigger.findAll((node) => typeof node.type === 'string')
        .flatMap((node) => node.children.filter((child) => typeof child === 'string'));
}

const declared: ResolvedInputTypeV1 = {
    identity: repositoryInputTypeRef,
    occurrenceId: 'occurrence-1',
    definition: { id: 'repository', ...repositoryInputTypes.repository },
};
const review = { repositoryId: 'example/review-assistant' };

describe('widget setup fields share the typed-field owners', () => {
    it('keeps an invalid own pin named while the public field offers repair choices', async () => {
        const { Item } = await import('@/components/ui/lists/Item');
        const onChange = vi.fn();
        const screen = await renderScreen(<WidgetSetupFieldRow
            entry={{ field: { path: 'source', title: 'Source', widget: 'select', optionsSourceId: 'sessions' } }}
            row={{ kind: 'invalid', label: 'Release source', issue: { path: 'source', status: 'unavailable', reasonCode: 'widget_input_option_unavailable' } }}
            options={[]} optionsStatus="ready" plainValue={{ serverId: 'home', sessionId: 'retired-source' }}
            phone={false} onChange={onChange} testID="setup.invalid" />);
        expect(screen.findByType(Item).props.subtitle).toContain('Release source');
        expect(onChange).not.toHaveBeenCalled();
        await screen.unmount();
    });
    it('uses the public choice owner for own long choices and collections, including limits and failed discovery', async () => {
        const { HappierInputField } = await import('@happier-dev/plugin-ui/presentation');
        const options = [{ value: 'auto', label: 'Best available cost' }, { value: 'reported', label: 'Reported by agents' }];
        const onChange = vi.fn();
        const props = { entry: { field: { path: 'cost', title: 'Cost', widget: 'select' as const } },
            row: { kind: 'needed' as const }, options, optionsStatus: 'ready' as const, plainValue: undefined,
            phone: false, onChange, testID: 'setup.cost' };
        const screen = await renderScreen(<WidgetSetupFieldRow {...props} />);
        expect(screen.findAllByType(HappierInputField)).toHaveLength(1);
        await screen.pressByTestIdAsync('setup.cost.control.trigger');
        await screen.pressByTestIdAsync('setup.cost.option.1');
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'pin', value: 'reported' });
        await screen.update(<WidgetSetupFieldRow {...props} entry={{ field: { ...props.entry.field, widget: 'multiselect', maxSelections: 1 } }}
            plainValue={['auto']} row={{ kind: 'pinned', value: null, label: 'Best available cost' }} />);
        await screen.pressByTestIdAsync('setup.cost.control.trigger');
        await screen.pressByTestIdAsync('setup.cost.option.1');
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'pin', value: ['reported'] });
        await screen.update(<WidgetSetupFieldRow {...props} optionsStatus="failed" />);
        expect(screen.findByTestId('setup.cost.option.1')?.props.accessibilityState.disabled).toBe(true);
        await screen.unmount();
    });
    it('shows a following input as its one binding control, and opens its own editor from the current value only when Own value is chosen (FA18 P2)', async () => {
        const { HappierInputField } = await import('@happier-dev/plugin-ui/presentation');
        const entry: WidgetSetupField = { field: { path: 'directory', title: 'Directory', widget: 'text' },
            follow: { slot: 'directory', label: 'This page', values: [{ value: 'src', label: 'src' }] } };
        const changes: WidgetSetupFieldChange[] = [];
        const render = (row: React.ComponentProps<typeof WidgetSetupFieldRow>['row'], plainValue?: string) => <WidgetSetupFieldRow entry={entry} row={row}
            options={[]} optionsStatus="ready" plainValue={plainValue} phone={false} onChange={change => changes.push(change)} testID="setup.dir" />;
        const screen = await renderScreen(render({ kind: 'follows', label: 'This page', valueLabel: 'src' }));
        // Following: the value is said once, by the binding; no second control repeats it.
        expect(screen.findAllByType(HappierInputField)).toHaveLength(0);
        expect(screen.findAllByType(DropdownMenu)).toHaveLength(1);
        expect(screen.findByType(DropdownMenu).props.items.map((item: { id: string }) => item.id)).toEqual(['follow', 'own']);
        act(() => { screen.findByType(DropdownMenu).props.onSelect('own'); });
        expect(changes).toEqual([{ kind: 'pin', value: 'src' }]);
        await act(async () => screen.update(render({ kind: 'pinned', value: null, label: 'src' }, 'src')));
        // Own value: the binding says whose value it is and the typed editor beneath holds it.
        expect(screen.findAllByType(HappierInputField)).toHaveLength(1);
        expect(bindingText(screen, 'setup.dir')).toEqual(['widgetAdd.ownValue']);
        act(() => { screen.findByType(DropdownMenu).props.onSelect('follow'); });
        expect(changes.at(-1)).toEqual({ kind: 'follow', slot: 'directory' });
        await screen.unmount();
    });
    it('pins a Usage scope as a collection from Own value and toggles its own selections', async () => {
        const candidate = selectBuiltinWidgetCandidates().find(candidate => candidate.definition?.kind === 'builtin'
            && candidate.definition.id === 'usage_daily')!;
        const setup = buildWidgetCandidateSetup({ candidate, context: { slots: { agents: {
            label: 'This page', value: { value: ['claude'], label: 'Claude' },
        } } }, audience: 'personal',
            mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }) });
        const entry = setup.fields.find(field => field.field.path === 'agents')!;
        const options = [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }];
        const changes: WidgetSetupFieldChange[] = [];
        const screen = await renderScreen(<WidgetSetupFieldRow entry={entry} row={{ kind: 'follows', label: 'This page', valueLabel: 'Claude' }}
            options={options} optionsStatus="ready" plainValue={undefined} phone={false}
            onChange={change => changes.push(change)} testID="setup.agents" />);
        act(() => { screen.findByType(DropdownMenu).props.onSelect('own'); });
        expect(changes).toEqual([{ kind: 'pin', value: ['claude'] }]);
        await act(async () => screen.update(<WidgetSetupFieldRow entry={entry} row={{ kind: 'pinned', value: null, label: 'Claude' }}
            options={options} optionsStatus="ready" plainValue={['claude']} phone={false}
            onChange={change => changes.push(change)} testID="setup.agents" />));
        await screen.pressByTestIdAsync('setup.agents.control.trigger');
        await screen.pressByTestIdAsync('setup.agents.option.1');
        expect(changes.at(-1)).toEqual({ kind: 'pin', value: ['claude', 'codex'] });
        await act(async () => screen.update(<WidgetSetupFieldRow entry={entry} row={{ kind: 'pinned', value: null, label: 'Claude · Codex' }}
            options={options} optionsStatus="ready" plainValue={['claude', 'codex']} phone={false}
            onChange={change => changes.push(change)} testID="setup.agents" />));
        await screen.pressByTestIdAsync('setup.agents.option.0');
        expect(changes.at(-1)).toEqual({ kind: 'pin', value: ['codex'] });
        await act(async () => screen.update(<WidgetSetupFieldRow entry={entry} row={{ kind: 'pinned', value: null, label: 'Codex' }}
            options={options} optionsStatus="ready" plainValue={['codex']} phone={false}
            onChange={change => changes.push(change)} testID="setup.agents" />));
        await screen.pressByTestIdAsync('setup.agents.option.1');
        expect(changes.at(-1)).toEqual({ kind: 'pin', value: [] });
    });
    it('offers every machine of the Home, offline ones too, and pins the qualified machine (plan 60 AGW-15)', async () => {
        const candidate = selectBuiltinWidgetCandidates().find(candidate => candidate.definition?.kind === 'builtin'
            && candidate.definition.id === 'machine_vitals')!;
        const setup = buildWidgetCandidateSetup({ candidate, context: {}, audience: 'personal', mode: { kind: 'add', submitLabel: 'Add' },
            submit: async () => ({ ok: true }) });
        const entry = setup.fields.find(field => field.field.path === 'machine')!;
        expect(entry.field.inputType).toEqual({ hostType: 'machine' });
        const options = [
            { value: { serverId: 'home', machineId: 'leeroy-mbp' }, label: 'leeroy-mbp', description: 'Online' },
            { value: { serverId: 'home', machineId: 'studio' }, label: 'studio', description: 'Offline' },
        ];
        const changes: WidgetSetupFieldChange[] = [];
        const screen = await renderScreen(<WidgetSetupFieldRow entry={entry} row={{ kind: 'needed' }} options={options} optionsStatus="ready"
            plainValue={undefined} phone={false} onChange={change => changes.push(change)} testID="setup.machine" />);
        await screen.pressByTestIdAsync('setup.machine.control.trigger');
        // Offline machines are offered too, each with its own state line.
        expect(screen.getTextContent()).toMatch(/leeroy-mbp.*Online.*studio.*Offline/);
        await screen.pressByTestIdAsync('setup.machine.option.1');
        expect(changes).toEqual([{ kind: 'pin', value: { serverId: 'home', machineId: 'studio' } }]);
    });
    it('asks the declared prompt for a setup choice while retaining the noun for search and empty-choice copy', async () => {
        const entry = { field: { path: 'repository', title: 'Repository', prompt: 'Which repository?', widget: 'select' as const,
            options: [{ value: 'repo', label: 'Repo' }] }, follow: { slot: 'repository', label: 'Following group', values: [] } };
        const screen = await renderScreen(<WidgetSetupFieldRow entry={entry} row={{ kind: 'needed' }}
            options={[{ value: 'repo', label: 'Repo' }]} optionsStatus="ready" plainValue={undefined}
            phone={false} onChange={() => {}} testID="setup.prompt" />);
        const { Item } = await import('@/components/ui/lists/Item');
        expect(screen.findAllByType(Item).filter(row => row.props.title === 'Which repository?')).toHaveLength(1);
        expect(screen.findByTestId('setup.prompt.trigger')!.props.accessibilityLabel).toContain('Which repository?');
        expect(entry.field.title).toBe('Repository');
    });
    it('offers the Usage Period in place as its named choices, never a dialog holding one dropdown (final-acceptance 4)', async () => {
        const { readUsagePeriodOptions } = await import('@happier-dev/protocol/inputs');
        const { StrictJsonValueSchema } = await import('@happier-dev/protocol/json/strictJsonValue');
        const candidate = selectBuiltinWidgetCandidates().find(candidate => candidate.definition?.kind === 'builtin'
            && candidate.definition.id === 'usage_daily')!;
        const setup = buildWidgetCandidateSetup({ candidate, context: {}, audience: 'personal',
            mode: { kind: 'add', submitLabel: 'Add' }, submit: async () => ({ ok: true }) });
        const declared = setup.fields.find(entry => entry.field.path === 'period')!;
        const { optionsSourceId: _explicitSource, ...field } = declared.field;
        const entry = { ...declared, field };
        const custom = { startMs: 100, endMs: 200 };
        // The Protocol inventory suite proves admitted type-only discovery reaches this
        // producer. Here its real output crosses the public field/selection boundary.
        const options = readUsagePeriodOptions(custom)
            .map(option => ({ value: StrictJsonValueSchema.parse(option.value), label: option.label }));
        expect(options.map(option => option.value)).toContainEqual({ relative: '7days' });
        const port = createInputTypePickerPort({
            resolveType: () => null, canOpenPicker: () => false,
            openPicker: async () => { throw new Error('no plugin picker'); },
            openHostPicker: async () => { throw new Error('the Period opens no dialog'); },
        });
        const onChange = vi.fn();
        const screen = await renderScreen(<HappierInputPickerProvider port={port}>
            <WidgetSetupFieldRow entry={entry} row={{ kind: 'needed' }} options={options} optionsStatus="ready"
                plainValue={undefined} phone={false} onChange={onChange} testID="usage.period" />
        </HappierInputPickerProvider>);
        // No Browse… beside it: the Period has no picker of its own.
        expect(port.describe(entry.field)).toBeNull();
        expect(screen.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'usage.period.control-picker')).toHaveLength(0);
        await screen.pressByTestIdAsync('usage.period.control.trigger');
        await screen.pressByTestIdAsync('usage.period.option.1');
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'pin', value: { relative: '7days' } });
        await screen.pressByTestIdAsync('usage.period.control.trigger');
        await screen.pressByTestIdAsync(`usage.period.option.${options.length - 1}`);
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'pin', value: custom });
        await screen.unmount();
    });
    it('chooses the Usage Session in place from the real Usage declaration in both Add and Edit, with no picker dialog', async () => {
        const candidate = selectBuiltinWidgetCandidates().find(candidate => candidate.definition?.kind === 'builtin'
            && candidate.definition.id === 'usage_daily')!;
        const before = { period: { startMs: 100, endMs: 200 }, session: ['saved'], metric: 'cost' };
        for (const mode of [
            { kind: 'add', submitLabel: 'Add', copiedInput: before },
            { kind: 'edit', instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'usage_daily' }, bindings: {
                period: { kind: 'value', value: before.period }, session: { kind: 'value', value: before.session },
                metric: { kind: 'value', value: before.metric },
            } } },
        ] as const) {
            const setup = buildWidgetCandidateSetup({ candidate, context: {}, audience: 'personal', mode,
                submit: async () => ({ ok: true }) });
            let draft = setup.initial;
            for (const [path, selected] of [['session', ['chosen']]] as const) {
                const entry = setup.fields.find(entry => entry.field.path === path)!;
                const saved = draft.bindings[path];
                const current = saved?.kind === 'value' ? saved.value : undefined;
                const port = createInputTypePickerPort({
                    resolveType: () => { throw new Error('Usage is a host input'); },
                    canOpenPicker: () => { throw new Error('Usage is a host input'); },
                    openPicker: async () => { throw new Error('Usage is a host input'); },
                    openHostPicker: async () => { throw new Error('The Session chooses in place'); },
                });
                const onChange = vi.fn((change: WidgetSetupFieldChange) => { draft = setWidgetSetupBinding(draft, path, change); });
                const options = [{ value: 'chosen', label: 'Orchard and meadow' }];
                const screen = await renderScreen(<HappierInputPickerProvider port={port}>
                    <WidgetSetupFieldRow entry={entry}
                        row={describeWidgetSetupRow({ entry, draft, resolution: setup.resolve(draft), options })}
                        options={options} optionsStatus="ready" plainValue={current} phone={false}
                        onChange={onChange} testID={`usage.${path}`} />
                </HappierInputPickerProvider>);
                expect(screen.root.findAll(node => typeof node.type === 'string' && node.props.testID === `usage.${path}.control-picker`)).toHaveLength(0);
                await screen.pressByTestIdAsync(`usage.${path}.control.trigger`);
                await screen.pressByTestIdAsync(`usage.${path}.option.0`);
                const [pinned] = selected;
                expect(draft.bindings[path]).toEqual({ kind: 'value', value: pinned });
                expect(draft.bindings.metric).toEqual({ kind: 'value', value: 'cost' });
                await screen.unmount();
            }
        }
    });
    it('pins a picked repository only after its type admits it, through the same picker port as Actions', async () => {
        let settlement: unknown = { kind: 'completed', input: { repositoryId: 'someone/else' } };
        const port = createInputTypePickerPort({
            resolveType: () => declared,
            canOpenPicker: () => true,
            openPicker: async () => settlement,
        });
        const entry: WidgetSetupField = {
            field: { path: 'repository', title: 'Repository', widget: 'select', inputType: repositoryInputTypeRef },
        };
        const onChange = vi.fn();
        const screen = await renderScreen(
            <HappierInputPickerProvider port={port}>
                <WidgetSetupFieldRow entry={entry} row={{ kind: 'needed' }}
                    options={[{ value: review, label: 'Review assistant' }]} optionsStatus="ready"
                    plainValue={undefined} phone={false} onChange={onChange} testID="setup.repository" />
            </HappierInputPickerProvider>,
        );
        const picker = () => screen.findByTestId('setup.repository.control-picker')!;
        expect(picker()).not.toBeNull();

        const choose = async () => {
            await act(async () => {
                picker().props.onPress();
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        };
        await choose();
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.findByType(HappierValidationMessage).props.message).toBe('inputPicker.invalid');

        settlement = { kind: 'completed', input: review };
        await choose();
        expect(onChange).toHaveBeenCalledWith({ kind: 'pin', value: review });
    });

    it('parses a number through the public field like Action fields: an incomplete draft stays text, a complete one is the number', async () => {
        const onChange = vi.fn();
        const screen = await renderScreen(
            <WidgetSetupFieldRow entry={{ field: { path: 'limit', title: 'Limit', widget: 'integer' } }}
                row={{ kind: 'needed' }} options={[]} optionsStatus="ready" plainValue={undefined}
                phone={false} onChange={onChange} testID="setup.limit" />,
        );
        // The draft keeps what was typed (the binder refuses it, so the step cannot finish), never a guess.
        screen.changeTextByTestId('setup.limit.input', '1.5');
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'pin', value: '1.5' });
        screen.changeTextByTestId('setup.limit.input', '3');
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'pin', value: 3 });
        screen.changeTextByTestId('setup.limit.input', '');
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'clear' });
    });
    it('says what a follow chip follows and then what it currently is, never the same word twice (F4 D-12)', async () => {
        const entry: WidgetSetupField = { field: { path: 'agents', title: 'Agents', widget: 'select', options: [] },
            follow: { slot: 'agents', label: 'This page', values: [{ value: [], label: 'All agents' }] } };
        const render = async (row: Extract<React.ComponentProps<typeof WidgetSetupFieldRow>['row'], { kind: 'follows' }>) => {
            const screen = await renderScreen(<WidgetSetupFieldRow entry={entry} row={row} options={[]} optionsStatus="ready"
                plainValue={undefined} phone={false} onChange={() => {}} testID="setup.agents" />);
            return bindingText(screen, 'setup.agents');
        };
        expect(await render({ kind: 'follows', label: 'This page', valueLabel: 'All agents' })).toEqual(['This page', 'All agents']);
        // A source whose value reads the same says it once.
        expect(await render({ kind: 'follows', label: 'Agents', valueLabel: 'Agents' })).toEqual(['Agents']);
    });
    it('moves a wide field beneath its label in a narrow row and keeps only a switch beside it (FA21 S1)', async () => {
        const { Item } = await import('@/components/ui/lists/Item');
        const layoutOf = async (field: WidgetSetupField['field']) => (await renderScreen(<WidgetSetupFieldRow entry={{ field }} row={{ kind: 'needed' }}
            options={[]} optionsStatus="ready" plainValue={undefined} phone={false} onChange={() => {}} testID="setup.field" />)).findByType(Item).props.accessoryLayout;
        // A text field is as wide as a select: in a pane column it goes beneath, never squeezing its label.
        expect(await layoutOf({ path: 'directory', title: 'Directory on the serving machine', widget: 'text', required: true })).toBe('adaptive');
        expect(await layoutOf({ path: 'hidden', title: 'Include hidden files', widget: 'boolean' })).toBe('inline');
    });
    it('offers two to four short choices as the shared field segmented control beside its title, not stacked tiles (F4 D-13)', async () => {
        const { HappierSegmentedChoice } = await import('@happier-dev/plugin-ui/presentation');
        const { Item } = await import('@/components/ui/lists/Item');
        const metric = selectBuiltinWidgetCandidates().find(candidate => candidate.definition?.kind === 'builtin'
            && candidate.definition.id === 'usage_daily')!.inputs!.fields.find(field => field.path === 'metric')!;
        const onChange = vi.fn();
        const options = metric.options!.map(option => ({ value: option.value, label: option.label }));
        const screen = await renderScreen(<WidgetSetupFieldRow entry={{ field: metric }} row={{ kind: 'pinned', value: options[0]!, label: options[0]!.label }}
            options={options} optionsStatus="ready" plainValue="tokens" phone={false} onChange={onChange} testID="setup.metric" />);
        const control = screen.findByType(HappierSegmentedChoice);
        expect(control.props.segments.map((segment: { label: string }) => segment.label)).toEqual(options.map(option => option.label));
        expect(control.props.segments.findIndex((segment: { selected: boolean }) => segment.selected)).toBe(0);
        // Beside its title when the row has room; never pushed beneath it like a list.
        expect(screen.findByType(Item).props.accessoryLayout).toBe('adaptive');
        act(() => { control.props.onSelect(1); });
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'pin', value: 'cost' });
    });
    it('shows the choice an unset own input reads as, from the widget declaration, in Add and Edit (final-acceptance 3a)', async () => {
        const { HappierSegmentedChoice } = await import('@happier-dev/plugin-ui/presentation');
        const candidate = selectBuiltinWidgetCandidates().find(candidate => candidate.definition?.kind === 'builtin'
            && candidate.definition.id === 'machine_metric')!;
        for (const mode of [
            { kind: 'add', submitLabel: 'Add' },
            { kind: 'edit', instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'machine_metric' }, bindings: {} } },
        ] as const) {
            const setup = buildWidgetCandidateSetup({ candidate, context: {}, audience: 'personal', mode, submit: async () => ({ ok: true }) });
            for (const [path, label] of [['metric', 'CPU'], ['range', '1 hour']] as const) {
                const entry = setup.fields.find(entry => entry.field.path === path)!;
                const options = entry.field.options!.map(option => ({ value: option.value as string, label: option.label }));
                const onChange = vi.fn();
                const screen = await renderScreen(<WidgetSetupFieldRow entry={entry}
                    row={describeWidgetSetupRow({ entry, draft: setup.initial, resolution: setup.resolve(setup.initial), options })}
                    options={options} optionsStatus="ready" plainValue={(setup.initial.bindings[path] as { value?: string } | undefined)?.value}
                    phone={false} onChange={onChange} testID={`setup.${path}`} />);
                const control = screen.findByType(HappierSegmentedChoice);
                expect(control.props.segments.filter((segment: { selected: boolean }) => segment.selected)
                    .map((segment: { label: string }) => segment.label)).toEqual([label]);
                // Choosing what it already reads as changes nothing.
                act(() => { control.props.onSelect(0); });
                expect(onChange).not.toHaveBeenCalled();
                await screen.unmount();
            }
        }
    });
    it('draws collections and long single choices as the one compact choice field, opening checkbox and radio rows', async () => {
        const fields = selectBuiltinWidgetCandidates().find(candidate => candidate.definition?.kind === 'builtin'
            && candidate.definition.id === 'usage_daily')!.inputs!.fields;
        const agents = fields.find(field => field.path === 'agents')!;
        const costBasis = fields.find(field => field.path === 'costBasis')!;
        const agentOptions = [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }];
        const several = await renderScreen(<WidgetSetupFieldRow entry={{ field: agents }} row={{ kind: 'needed' }}
            options={agentOptions} optionsStatus="ready" plainValue={undefined} phone={false} onChange={() => {}} testID="setup.agents" />);
        await several.pressByTestIdAsync('setup.agents.control.trigger');
        const checkbox = several.findByTestId('setup.agents.option.0')!;
        expect(checkbox.props.accessibilityRole ?? checkbox.props.role).toBe('checkbox');
        const longLabels = [{ value: 'auto', label: 'Best available cost' }, { value: 'reported', label: 'Reported by agents' },
            { value: 'estimated', label: 'Estimated at list price' }, { value: 'api_equivalent', label: 'API equivalent' }];
        const single = await renderScreen(<WidgetSetupFieldRow entry={{ field: costBasis }} row={{ kind: 'needed' }}
            options={longLabels} optionsStatus="ready" plainValue={undefined} phone={false} onChange={() => {}} testID="setup.cost" />);
        await single.pressByTestIdAsync('setup.cost.control.trigger');
        const radio = single.findByTestId('setup.cost.option.0')!;
        expect(radio.props.accessibilityRole ?? radio.props.role).toBe('radio');
    });
});
