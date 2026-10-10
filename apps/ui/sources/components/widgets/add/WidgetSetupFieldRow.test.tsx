import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { HappierInputPickerProvider } from '@happier-dev/plugin-ui/presentation';
import type { ResolvedInputTypeV1 } from '@happier-dev/protocol/inputs/runtime';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { createInputTypePickerPort } from '@/components/sessions/actions/inputTypePickerPort';
import { selectBuiltinWidgetCandidates } from '@/components/widgets/widgetCatalog';
import { buildWidgetCandidateSetup } from '@/components/widgets/surface/widgetSurfaceSetup';
import { describeWidgetSetupRow, setWidgetSetupBinding } from './widgetSetupModel';

import {
    repositoryInputTypeRef,
    repositoryInputTypes,
} from '../../../../../../packages/plugin-sdk/examples/public-authoring/inputTypes';
import { WidgetSetupFieldRow, type WidgetSetupFieldChange } from './WidgetSetupFieldRow';
import type { WidgetSetupField } from './widgetSetupModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));

afterEach(() => { standardCleanup(); });

const declared: ResolvedInputTypeV1 = {
    identity: repositoryInputTypeRef,
    occurrenceId: 'occurrence-1',
    definition: { id: 'repository', ...repositoryInputTypes.repository },
};
const review = { repositoryId: 'example/review-assistant' };

describe('widget setup fields share the typed-field owners', () => {
    it('uses typed Period and Session pickers from the real Usage declaration in both Add and Edit', async () => {
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
            for (const [path, selected] of [['period', { startMs: 300, endMs: 400 }], ['session', ['chosen']]] as const) {
                const entry = setup.fields.find(entry => entry.field.path === path)!;
                const saved = draft.bindings[path];
                const current = saved?.kind === 'value' ? saved.value : undefined;
                let settlement: unknown = { kind: 'cancelled' };
                const port = createInputTypePickerPort({
                    resolveType: () => { throw new Error('Usage is a host input'); },
                    canOpenPicker: () => { throw new Error('Usage is a host input'); },
                    openPicker: async () => { throw new Error('Usage is a host input'); },
                    // This is the modal boundary; picker admission and Add/Edit binding logic stay real.
                    openHostPicker: async request => {
                        expect(request.value).toEqual(current);
                        return settlement;
                    },
                });
                const onChange = vi.fn((change: WidgetSetupFieldChange) => { draft = setWidgetSetupBinding(draft, path, change); });
                const screen = await renderScreen(<HappierInputPickerProvider port={port}>
                    <WidgetSetupFieldRow entry={entry}
                        row={describeWidgetSetupRow({ entry, draft, resolution: setup.resolve(draft), options: [] })}
                        options={[]} optionsStatus="ready" plainValue={current} phone={false}
                        onChange={onChange} testID={`usage.${path}`} />
                </HappierInputPickerProvider>);
                const menu = screen.findByType(DropdownMenu);
                expect(menu.props.items.map((item: { id: string }) => item.id)).toContain('picker');
                const choose = async () => act(async () => {
                    screen.findByType(DropdownMenu).props.onSelect('picker');
                    await new Promise(resolve => setTimeout(resolve, 0));
                });
                await choose();
                expect(onChange).not.toHaveBeenCalled();
                settlement = { kind: 'completed', input: selected };
                await choose();
                expect(draft.bindings[path]).toEqual({ kind: 'value', value: selected });
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
        const menu = () => screen.findByType(DropdownMenu);
        expect(menu().props.items.map((item: { id: string }) => item.id)).toContain('picker');

        const choose = async () => {
            await act(async () => {
                menu().props.onSelect('picker');
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        };
        await choose();
        expect(onChange).not.toHaveBeenCalled();
        expect(menu().props.itemTrigger.subtitle).toBe('inputPicker.invalid');

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
});
