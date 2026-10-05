import { describe, expect, it, vi } from 'vitest';
import { HappierInputPickerProvider } from '@happier-dev/plugin-ui/presentation';
import { ActionInputFieldHintSchema, type EffectiveActionInputField } from '@happier-dev/protocol';
import { readInputTypeOptions, type ResolvedInputTypeV1 } from '@happier-dev/protocol/inputs/runtime';
import { act } from 'react-test-renderer';
import { findTestInstanceByTypeContainingText, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

import {
    repositoryInputTypeRef,
    repositoryInputTypes,
    repositoryResources,
} from '../../../../../../packages/plugin-sdk/examples/public-authoring/inputTypes';
import { installSessionActionsCommonModuleMocks } from './sessionActionsTestHelpers';

installSessionActionsCommonModuleMocks();

// The public authoring example's declared repository type, its options Resource and picker.
const declared: ResolvedInputTypeV1 = {
    identity: repositoryInputTypeRef,
    occurrenceId: 'occurrence-1',
    definition: { id: 'repository', ...repositoryInputTypes.repository },
};
const choices = readInputTypeOptions(declared, JSON.parse(repositoryResources['review-repositories'].runtime.read()));
const savedValue = { repositoryId: 'example/review-assistant' };

const field: EffectiveActionInputField = {
    ...ActionInputFieldHintSchema.parse({
        path: 'repository', title: 'Repository', widget: 'select', inputType: repositoryInputTypeRef,
    }),
    visible: true,
    required: true,
    disabled: false,
};

/** Presses the picker control and lets the host's asynchronous settlement land. */
async function choose(control: Parameters<typeof pressTestInstanceAsync>[0]): Promise<void> {
    await pressTestInstanceAsync(control, 'picker');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mountFields(options: Readonly<{
    type?: ResolvedInputTypeV1 | null;
    /** What the plugin's picker renderer settles to (the genuine boundary). */
    settlement?: unknown;
    withPort?: boolean;
}> = {}) {
    const { ActionInputFields } = await import('./ActionInputFields');
    const { createInputTypePickerPort } = await import('./inputTypePickerPort');
    const onPatch = vi.fn();
    const openPicker = vi.fn(async (_request: Parameters<Parameters<typeof createInputTypePickerPort>[0]['openPicker']>[0]) => options.settlement ?? { kind: 'cancelled' });
    const port = createInputTypePickerPort({
        resolveType: () => options.type === undefined ? declared : options.type,
        canOpenPicker: (picker) => picker.pluginId === repositoryInputTypeRef.pluginId && picker.localId === 'review-native',
        openPicker,
    });
    const fields = (
        <ActionInputFields
            fields={[field]}
            input={{ repository: savedValue }}
            editable
            resolveFieldOptions={() => choices ?? []}
            onPatch={onPatch}
        />
    );
    const screen = await renderScreen(options.withPort === false ? fields
        : <HappierInputPickerProvider port={port}>{fields}</HappierInputPickerProvider>);
    const browse = () => screen.findAllByType('Pressable').find((node) =>
        (node.props.accessibilityLabel ?? node.props['aria-label']) === 'inputPicker.browseField');
    return { screen, browse, onPatch, openPicker };
}

describe('Action fields with a declared custom picker', () => {
    it('writes the picker’s answer only after the Protocol owner validated it', async () => {
        expect(choices).toHaveLength(1);
        const { browse, onPatch, openPicker } = await mountFields({
            settlement: { kind: 'completed', input: { repositoryId: 'example/review-assistant' } },
        });

        await choose(browse());

        expect(openPicker).toHaveBeenCalledOnce();
        expect(openPicker.mock.calls[0]?.[0]).toMatchObject({
            picker: { pluginId: repositoryInputTypeRef.pluginId, localId: 'review-native' },
            launchInput: { inputType: repositoryInputTypeRef, value: savedValue },
        });
        expect(onPatch).toHaveBeenCalledWith({ repository: { repositoryId: 'example/review-assistant' } });
    });

    it('keeps the saved value and says why when the picker answers with a value the type refuses', async () => {
        const { screen, browse, onPatch } = await mountFields({
            settlement: { kind: 'completed', input: { repositoryId: 'someone/else' } },
        });

        await choose(browse());

        expect(onPatch).not.toHaveBeenCalled();
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'inputPicker.invalid')).toBeDefined();
    });

    it('changes nothing and shows no error when the picker is cancelled', async () => {
        const { screen, browse, onPatch } = await mountFields({ settlement: { kind: 'cancelled' } });

        await choose(browse());

        expect(onPatch).not.toHaveBeenCalled();
        for (const message of ['inputPicker.invalid', 'inputPicker.failed', 'inputPicker.unavailable', 'inputPicker.retired']) {
            expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', message)).toBeUndefined();
        }
    });

    it('offers no picker for an uninstalled type, and none without a host port, while the field still works', async () => {
        for (const mounted of [await mountFields({ type: null }), await mountFields({ withPort: false })]) {
            expect(mounted.browse()).toBeUndefined();
            const saved = findTestInstanceByTypeContainingText(mounted.screen.tree, 'Pressable', 'Review assistant');
            expect(saved).toBeDefined();
            expect(saved?.props.accessibilityState?.checked ?? saved?.props['aria-checked']).toBe(true);
        }
    });
});
