import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { HappierInputPickerProvider, HappierValidationMessage } from '@happier-dev/plugin-ui/presentation';
import type { ResolvedInputTypeV1 } from '@happier-dev/protocol/inputs/runtime';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';
import { createInputTypePickerPort } from '@/components/sessions/actions/inputTypePickerPort';
import { selectBuiltinWidgetCandidates } from '@/components/widgets/widgetCatalog';
import { buildWidgetCandidateSetup, widgetGroupSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
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
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key, params) => key === 'widgetAdd.inheritedValue' ? `${params?.value} (${params?.source})` : key,
}));

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
    it('keeps the child preview out of the binding choices', async () => {
        const field = { path: 'note', title: 'Note', widget: 'text' as const };
        const option = { value: 'Shared note', label: 'Shared note' };
        const follow = { slot: 'note', label: 'This page', values: [option] };
        const render = (state: Pick<React.ComponentProps<typeof WidgetSetupFieldRow>, 'entry' | 'row' | 'plainValue'>) =>
            <WidgetSetupFieldRow {...state} options={[]} optionsStatus="ready" phone
                onChange={() => {}} testID="setup.note" />;
        const needed = { kind: 'needed' } as const;
        const inherited = { kind: 'single', valueLabel: option.label } as const;
        const screen = await renderScreen(render({ entry: { field, follow, inherited }, row: needed, plainValue: undefined }));
        expect.soft(bindingText(screen, 'setup.note')).toEqual(['widgetAdd.needed']);
        expect.soft(screen.findByTestId('setup.note.trigger')?.props.accessibilityLabel).toBe('Note, widgetAdd.needed');
        expect(screen.findByTestId('setup.note.input')?.props.placeholder).toBe('Shared note');
        expect(screen.findByTestId('setup.note.input')?.props.value).toBe('');
        await screen.pressByTestIdAsync('setup.note.trigger');
        expect(screen.findByType(DropdownMenu).props.items).toMatchObject([
            { id: 'follow', title: 'Shared note (This page)', checked: false },
            { id: 'own', title: 'widgetAdd.ownValue', checked: false },
        ]);
        await screen.update(render({ entry: { field, follow, inherited }, row: { kind: 'pinned', value: null, label: 'Personal note' }, plainValue: 'Personal note' }));
        expect(bindingText(screen, 'setup.note')).toEqual(['widgetAdd.ownValue']);
        expect(screen.findByTestId('setup.note.input')?.props.value).toBe('Personal note');
        await screen.update(render({ entry: { field, follow }, row: { kind: 'follows', label: follow.label, valueLabel: option.label }, plainValue: undefined }));
        expect.soft(bindingText(screen, 'setup.note')).toEqual(['Shared note (This page)']);
        expect.soft(screen.findByTestId('setup.note.trigger')?.props.accessibilityLabel).toBe('Note, Shared note (This page)');
        expect(screen.findByType(DropdownMenu).props.items).toMatchObject([
            { id: 'follow', title: 'Shared note (This page)', checked: true },
            { id: 'own', checked: false },
        ]);
        await screen.update(render({ entry: { field, follow: { ...follow, values: [] } }, row: needed, plainValue: undefined }));
        expect.soft(bindingText(screen, 'setup.note')).toEqual(['widgetAdd.needed']);
        await screen.pressByTestIdAsync('setup.note.trigger');
        expect(screen.findByType(DropdownMenu).props.items.filter((item: { checked?: boolean }) => item.checked)).toEqual([]);
    });

    it('keeps the resolved group value at the leading edge of the Edit inputs trigger and option', async () => {
        const value = { relative: '90days' };
        const ownValue = { relative: 'today' };
        const valueLabel = 'Last 90 days';
        const ownOption = { value: ownValue, label: 'Today' };
        const candidate = selectBuiltinWidgetCandidates().find(candidate => candidate.definition?.kind === 'builtin'
            && candidate.definition.id === 'usage_period_summary')!;
        const instance = {
            v: 1 as const, id: 'summary', definition: { kind: 'builtin' as const, id: 'usage_period_summary' },
            bindings: { period: { kind: 'context' as const, slot: 'period' } },
        };
        const context = widgetGroupSurfaceContext({}, { period: { kind: 'value', value } }, {
            fields: [], byChild: new Map(), labels: { period: valueLabel },
        });
        const setup = buildWidgetCandidateSetup({
            candidate, context, audience: 'personal', mode: { kind: 'edit', instance }, submit: async () => ({ ok: true }),
        });
        const entry = setup.fields.find(({ field }) => field.path === 'period')!;
        const options = [ownOption];
        const render = (draft = setup.initial, plainValue?: typeof ownValue) => <WidgetSetupFieldRow entry={entry}
            row={describeWidgetSetupRow({ entry, draft, resolution: setup.resolve(draft), options })}
            options={options} optionsStatus="ready" plainValue={plainValue} phone={true}
            onChange={() => {}} testID="edit.period" />;
        const screen = await renderScreen(render());
        const reading = 'Last 90 days (widgetFrame.followingGroup)';
        expect.soft(bindingText(screen, 'edit.period')).toEqual([reading]);
        expect.soft(screen.findByTestId('edit.period.trigger')?.props.accessibilityLabel).toBe(`Period, ${reading}`);
        await screen.pressByTestIdAsync('edit.period.trigger');
        expect.soft(screen.findByType(DropdownMenu).props.items[0]).toMatchObject({ id: 'follow', title: reading, checked: true });
        expect.soft(screen.getTextContent()).toContain(reading);
        await screen.update(render({ ...setup.initial, bindings: { period: { kind: 'value', value: ownValue } } }, ownValue));
        expect(bindingText(screen, 'edit.period')).toEqual(['widgetAdd.ownValue']);
        expect(screen.getTextContent()).toContain('Today');
    });

    describe('inherited group readings', () => {
        const single = { kind: 'single', valueLabel: 'Resolved value', source: 'group' } as const;
        const several = { kind: 'several', source: 'group' } as const;
        const singleReading = 'Resolved value (widgetFrame.followingGroup)';
        const severalReading = 'widgetAdd.severalValues (widgetFrame.followingGroup)';
        const choices = [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }];
        const longChoices = [{ value: 'one', label: 'First long option' }, { value: 'two', label: 'Second long option' }];
        const port = createInputTypePickerPort({ resolveType: () => declared, canOpenPicker: () => true, openPicker: async () => null });
        const props = { row: { kind: 'needed' }, options: [], optionsStatus: 'ready', plainValue: undefined,
            phone: false, onChange: vi.fn(), testID: 'inherited' } as const;
        const colorOf = (screen: Awaited<ReturnType<typeof renderScreen>>, reading: string) =>
            screen.root.findAll(node => typeof node.type === 'string' && node.children.includes(reading))
                .map(node => flattenTestStyle(node.props.style).color).find(color => typeof color === 'string')?.toLowerCase();
        const render = (entry: WidgetSetupField, options: typeof choices = [], value?: string) =>
            <HappierInputPickerProvider port={port}>
                <WidgetSetupFieldRow {...props} entry={entry} options={options} plainValue={value}
                    row={value === undefined ? props.row : { kind: 'pinned', value, label: 'First long option' }} />
            </HappierInputPickerProvider>;
        const text = { path: 'field', title: 'Field', widget: 'text', placeholder: 'Authored prompt' } as const;
        const quietInk = async () => {
            const screen = await renderScreen(render({ field: text }));
            const color = screen.findByTestId('inherited.input')?.props.placeholderTextColor;
            await screen.unmount();
            expect(color).toBeTypeOf('string');
            return color.toLowerCase();
        };

        it.each(['text', 'integer', 'text_list', 'json'] as const)(
            'uses existing placeholder ink for one, several and unbound %s inputs', async widget => {
                const field = { ...text, widget };
                const screen = await renderScreen(render({ field, inherited: single }));
                expect(screen.findByTestId('inherited.input')?.props.placeholder).toBe(singleReading);
                expect(screen.findByTestId('inherited.input')?.props.placeholderTextColor?.toLowerCase()).toBe(await quietInk());
                await screen.update(render({ field, inherited: several }));
                expect(screen.findByTestId('inherited.input')?.props.placeholder).toBe(severalReading);
                await screen.update(render({ field }));
                expect(screen.findByTestId('inherited.input')?.props.placeholder).toBe('Authored prompt');
            },
        );

        it.each(['select', 'multiselect'] as const)(
            'keeps inherited %s readings in placeholder ink and a chosen reading in value ink', async widget => {
                const field = { ...text, widget };
                const quiet = await quietInk();
                const screen = await renderScreen(render({ field, inherited: single }, longChoices));
                expect(colorOf(screen, singleReading)).toBe(quiet);
                await screen.update(render({ field, inherited: several }, longChoices));
                expect(colorOf(screen, severalReading)).toBe(quiet);
                const follow = { slot: field.path, label: 'This page', values: [] };
                await screen.update(render({ field, follow, inherited: single }, longChoices));
                expect.soft(bindingText(screen, 'inherited')).toEqual(['widgetAdd.needed']);
                expect.soft(colorOf(screen, single.valueLabel)).toBe(quiet);
                expect.soft(colorOf(screen, singleReading)).toBeUndefined();
                expect.soft(screen.findByTestId('inherited.control.trigger')?.props.accessibilityLabel).toBe(`Field: ${singleReading}`);
                await screen.update(render({ field, follow, inherited: several }, longChoices));
                expect.soft(bindingText(screen, 'inherited')).toEqual(['widgetAdd.needed']);
                expect.soft(colorOf(screen, 'widgetAdd.severalValues')).toBe(quiet);
                expect.soft(colorOf(screen, severalReading)).toBeUndefined();
                expect.soft(screen.findByTestId('inherited.control.trigger')?.props.accessibilityLabel).toBe(`Field: ${severalReading}`);
                await screen.update(render({ field }, longChoices));
                expect(colorOf(screen, 'Authored prompt')).toBeTypeOf('string');
                await screen.update(render({ field: { ...field, widget: 'select' }, inherited: single }, longChoices, 'one'));
                expect(colorOf(screen, 'First long option')).toBeTypeOf('string');
                expect(colorOf(screen, 'First long option')).not.toBe(quiet);
                expect(colorOf(screen, singleReading)).toBeUndefined();
            },
        );

        it.each([
            { widget: 'select', options: choices, control: 'inherited.control.segmented' },
            { widget: 'boolean', options: [], control: 'inherited.input' },
            { widget: 'select', inputType: repositoryInputTypeRef, options: [], control: 'inherited.control-picker' },
        ] as const)('uses the existing secondary line for $control with no placeholder slot', async ({ widget, options, control, ...rest }) => {
            const field = { ...text, widget, description: 'Original secondary line', ...rest };
            const quiet = await quietInk();
            const screen = await renderScreen(render({ field, inherited: single }, [...options]));
            expect(screen.findByTestId(control)).not.toBeNull();
            expect(colorOf(screen, singleReading)).toBe(quiet);
            if (options.length > 0) {
                const { HappierSegmentedChoice } = await import('@happier-dev/plugin-ui/presentation');
                expect(screen.findByType(HappierSegmentedChoice).props.segments.every((segment: { selected: boolean }) => !segment.selected)).toBe(true);
            }
            await screen.update(render({ field, inherited: several }, [...options]));
            expect(colorOf(screen, severalReading)).toBe(quiet);
            await screen.update(render({ field }, [...options]));
            expect(colorOf(screen, 'Original secondary line')).toBeDefined();
            expect(colorOf(screen, singleReading)).toBeUndefined();
        });
    });

    const calendarOperand = { relative: '30days' };
    Object.setPrototypeOf(calendarOperand, null);

    it.each([
        { name: 'a calendar object', widget: 'number', schema: 'number', operand: calendarOperand, ownDisplay: '' },
        { name: 'a calendar array', widget: 'number', schema: 'number', operand: [calendarOperand], ownDisplay: '' },
        { name: 'null', widget: 'number', schema: 'number', operand: null, ownDisplay: '' },
        { name: 'a numeric text draft', widget: 'number', schema: 'number', operand: '1e', ownDisplay: '1e' },
        { name: 'a number in a text field', widget: 'text', schema: 'string', operand: 2, ownDisplay: '' },
    ] as const)('keeps invalid follow and Own value editable for $name', async ({ widget, schema, operand, ownDisplay }) => {
        const definition = { kind: 'builtin', id: 'fixture' } as const;
        const candidate = {
            key: 'fixture', title: 'Fixture', pluginName: 'Fixture', sharedPluginName: false, icon: 'squares-four',
            homeDefault: 'available', target: 'app', definition,
            inputs: { fields: [{ path: 'period', title: 'Numeric calendar', widget, contextMode: 'follow', required: true }] },
            inputSchema: { type: 'object', required: ['period'], properties: { period: { type: schema } } },
        } as const;
        const setup = buildWidgetCandidateSetup({
            candidate, audience: 'personal',
            context: { slots: { period: { label: 'This page', value: { label: 'Last 30 days', value: operand } } } },
            mode: { kind: 'edit', instance: { v: 1, id: 'fixture', definition, bindings: { period: { kind: 'context', slot: 'period' } } } },
            submit: async () => ({ ok: true }),
        });
        const entry = setup.fields[0]!;
        const onChange = vi.fn<(change: WidgetSetupFieldChange) => void>();
        const render = (draft = setup.initial) => {
            const binding = draft.bindings.period;
            return <WidgetSetupFieldRow entry={entry} options={[]} optionsStatus="ready"
                row={describeWidgetSetupRow({ entry, draft, resolution: setup.resolve(draft), options: [] })}
                plainValue={binding?.kind === 'value' ? binding.value : undefined}
                phone={false} onChange={onChange} testID="setup.invalidFollow" />;
        };
        expect(setup.resolve(setup.initial).status).not.toBe('ready');
        const screen = await renderScreen(render());
        expect(bindingText(screen, 'setup.invalidFollow')).toEqual(['This page', 'widgetAdd.invalidValue']);
        expect(screen.findByTestId('setup.invalidFollow.trigger')?.props.accessibilityLabel)
            .toBe('Numeric calendar, This page widgetAdd.invalidValue');
        await screen.pressByTestIdAsync('setup.invalidFollow.trigger');
        expect.soft(screen.findByType(DropdownMenu).props.items).toMatchObject([
            { id: 'follow', checked: true, title: 'This page', subtitle: 'widgetAdd.invalidValue' },
            { id: 'own', checked: false },
        ]);
        act(() => { screen.findByType(DropdownMenu).props.onSelect('own'); });
        expect.soft(onChange).toHaveBeenCalledWith({ kind: 'clear' });
        const change = onChange.mock.lastCall?.[0];
        const empty = setWidgetSetupBinding(setup.initial, 'period', { kind: 'clear' });
        expect(change).toEqual({ kind: 'clear' });
        expect(setup.resolve(empty).status).not.toBe('ready');
        await screen.update(render(empty));
        expect(screen.findByTestId('setup.invalidFollow.input')?.props.value).toBe('');
        expect.soft(bindingText(screen, 'setup.invalidFollow')).toEqual(['widgetAdd.ownValue']);
        expect.soft(screen.findByTestId('setup.invalidFollow.trigger')?.props.accessibilityLabel)
            .toBe('Numeric calendar, widgetAdd.ownValue');
        expect.soft(screen.findByType(DropdownMenu).props.items).toMatchObject([
            { id: 'follow', checked: false }, { id: 'own', checked: true },
        ]);

        // A stored pin can become invalid after the field changes type. The same typed
        // control must still mount for repair while the binder holds Save disabled.
        const own = setWidgetSetupBinding(setup.initial, 'period', { kind: 'pin', value: operand });
        expect(setup.resolve(own).status).not.toBe('ready');
        await screen.update(render(own));
        expect(bindingText(screen, 'setup.invalidFollow')).toEqual(['widgetAdd.ownValue', 'widgetAdd.invalidValue']);
        expect(screen.findByTestId('setup.invalidFollow.trigger')?.props.accessibilityLabel)
            .toBe('Numeric calendar, widgetAdd.ownValue widgetAdd.invalidValue');
        expect(screen.findByTestId('setup.invalidFollow.input')?.props.value).toBe(ownDisplay);
        await screen.pressByTestIdAsync('setup.invalidFollow.trigger');
        expect(screen.findByType(DropdownMenu).props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'follow', checked: false }),
            expect.objectContaining({ id: 'own', checked: true, title: 'widgetAdd.ownValue', subtitle: 'widgetAdd.invalidValue' }),
        ]));
    });

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
    it('replaces a settled empty scope chooser with its empty state and keeps its binding menu', async () => {
        const screen = await renderScreen(<WidgetSetupFieldRow
            entry={{ field: { path: 'agents', title: 'Agents', widget: 'multiselect',
                optionsSourceId: 'usage.filters.agents', placeholder: 'All agents' },
                follow: { slot: 'agents', label: 'This page', values: [{ label: 'All agents', value: [] }] } }}
            row={{ kind: 'needed' }} options={[]} optionsStatus="ready" plainValue={undefined}
            phone testID="setup.agents" onChange={() => {}} />);
        expect.soft(screen.getTextContent()).toContain('widgetAdd.noChoices');
        expect.soft(screen.findByTestId('setup.agents.control.trigger')).toBeNull();
        await screen.pressByTestIdAsync('setup.agents.trigger');
        expect(screen.findByType(DropdownMenu).props.items).toMatchObject([
            { id: 'follow', checked: false }, { id: 'own', checked: false },
        ]);
    });

    it('reads the inherited value and its source when its own fixed catalog is empty', async () => {
        const screen = await renderScreen(<WidgetSetupFieldRow
            entry={{ field: { path: 'agents', title: 'Agents', widget: 'select', optionsSourceId: 'usage.filters.agents' },
                follow: { slot: 'agents', label: 'This page', values: [] },
                inherited: { kind: 'single', valueLabel: 'Other slot agent', source: 'page' } }}
            row={{ kind: 'needed' }} options={[]} optionsStatus="ready" plainValue={undefined}
            phone testID="setup.otherSlot" onChange={() => {}} />);
        expect.soft(screen.getTextContent()).toContain('Other slot agent');
        expect(screen.findByTestId('setup.otherSlot.control.trigger')?.props.accessibilityLabel)
            .toContain('Other slot agent (widgetAdd.thisPage)');
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
        expect(screen.findByTestId('setup.agents.option.1')).not.toBeNull();
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
    it('names the followed value first without repeating the source when both names are the same', async () => {
        const entry: WidgetSetupField = { field: { path: 'agents', title: 'Agents', widget: 'select', options: [] },
            follow: { slot: 'agents', label: 'This page', values: [{ value: [], label: 'All agents' }] } };
        const render = async (row: Extract<React.ComponentProps<typeof WidgetSetupFieldRow>['row'], { kind: 'follows' }>) => {
            const screen = await renderScreen(<WidgetSetupFieldRow entry={entry} row={row} options={[]} optionsStatus="ready"
                plainValue={undefined} phone={false} onChange={() => {}} testID="setup.agents" />);
            return bindingText(screen, 'setup.agents');
        };
        expect(await render({ kind: 'follows', label: 'This page', valueLabel: 'All agents' })).toEqual(['All agents (This page)']);
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

describe('a sourced input with nothing to choose (DESIGN-1118-B M6)', () => {
    const sourced = (optionsSourceId: string, options: readonly { value: string; label: string }[] = []) => ({
        entry: { field: { path: 'check', title: 'Check', prompt: 'Which check?', widget: 'select' as const, required: true, optionsSourceId } },
        row: { kind: 'needed' as const }, options, optionsStatus: 'ready' as const, plainValue: undefined,
        phone: false, onChange: vi.fn(), testID: 'setup.check',
    });
    it('says there is nothing to choose yet and offers the source’s next step instead of a picker that cannot succeed', async () => {
        const { HappierInputField } = await import('@happier-dev/plugin-ui/presentation');
        const screen = await renderScreen(<WidgetSetupFieldRow {...sourced('health.checks.saved')} />);
        expect(screen.findAllByType(HappierInputField)).toHaveLength(0);
        expect(screen.getTextContent()).toContain('projects.deployments.monitoring.widgetNoChecks');
        expect(screen.findByTestId('setup.check.emptyAction')).not.toBeNull();
        await screen.unmount();
    });
    it('says the same for any other source, without an action it does not have', async () => {
        const { HappierInputField } = await import('@happier-dev/plugin-ui/presentation');
        const screen = await renderScreen(<WidgetSetupFieldRow {...sourced('sessions')} />);
        expect(screen.findAllByType(HappierInputField)).toHaveLength(0);
        expect(screen.getTextContent()).toContain('widgetAdd.noChoices');
        expect(screen.findByTestId('setup.check.emptyAction')).toBeNull();
        await screen.unmount();
    });
    it('keeps the choice field when the source has choices', async () => {
        const { HappierInputField } = await import('@happier-dev/plugin-ui/presentation');
        const screen = await renderScreen(<WidgetSetupFieldRow {...sourced('health.checks.saved', [{ value: 'a', label: 'Checkout' }])} />);
        expect(screen.findAllByType(HappierInputField)).toHaveLength(1);
        expect(screen.findByTestId('setup.check.emptyAction')).toBeNull();
        await screen.unmount();
    });
});
