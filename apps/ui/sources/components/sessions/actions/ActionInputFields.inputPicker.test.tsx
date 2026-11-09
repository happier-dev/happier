// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { HappierInputPickerProvider } from '@happier-dev/plugin-ui/presentation';
import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import { InputFieldHintSchema as ActionInputFieldHintSchema} from '@happier-dev/protocol/inputs/inputFields';
import { type EffectiveInputField  as EffectiveActionInputField} from '@happier-dev/protocol/inputs/inputFieldRuntime';
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
vi.mock('@/utils/web/reactDomCjs', async () => (await import('@/dev/testkit/mocks/reactDomCjs')).createReactDomCjsRendererMock());

// Load the real form after its boundary installation during collection, not
// inside the first interaction's timeout on a cold source worker.
const { ActionInputFields } = await import('./ActionInputFields');

// The public authoring example's declared repository type, its options Resource and picker.
const declared: ResolvedInputTypeV1 = {
    identity: repositoryInputTypeRef,
    occurrenceId: 'occurrence-1',
    definition: { id: 'repository', ...repositoryInputTypes.repository },
};
const repositoryResource = repositoryResources['review-repositories'];
if (repositoryResource.source !== 'dynamic') throw new Error('The example repository Resource must be dynamic');
const repositoryOptions = await repositoryResource.runtime.read(createTestResourceInvocationContext());
const repositoryOptionsPage = JSON.parse(
    typeof repositoryOptions === 'string' ? repositoryOptions : new TextDecoder().decode(repositoryOptions),
);
const choices = readInputTypeOptions(declared, repositoryOptionsPage.options);
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
            // The compact field names the saved choice and opens its rows in place.
            await pressTestInstanceAsync(mounted.screen.findAllByType('Pressable')
                .find((node) => String(node.props.accessibilityLabel ?? '').startsWith('Repository:')));
            const saved = mounted.screen.findAllByType('Pressable').find((node) => node.props.accessibilityRole === 'radio'
                && String(node.props.accessibilityLabel ?? '').startsWith('Review assistant'));
            expect(saved).toBeDefined();
            expect(saved?.props.accessibilityState?.checked ?? saved?.props['aria-checked']).toBe(true);
        }
    });
});
