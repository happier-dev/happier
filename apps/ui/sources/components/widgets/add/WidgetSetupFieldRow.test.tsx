import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { HappierInputPickerProvider } from '@happier-dev/plugin-ui/presentation';
import type { ResolvedInputTypeV1 } from '@happier-dev/protocol/inputs/runtime';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { createInputTypePickerPort } from '@/components/sessions/actions/inputTypePickerPort';

import {
    repositoryInputTypeRef,
    repositoryInputTypes,
} from '../../../../../../packages/plugin-sdk/examples/public-authoring/inputTypes';
import { WidgetSetupFieldRow } from './WidgetSetupFieldRow';
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
