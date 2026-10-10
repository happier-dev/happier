import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import { listModelPackCatalogEntries, type DaemonVoiceInferenceModelStatus } from '@happier-dev/protocol';

import { DaemonModelPackRow, SelectedDaemonModelPackRow } from './DaemonModelPackRow';
import type { ModelCatalogRow } from './buildModelCatalogRows';
import { DaemonVoiceModelCatalogProvider } from './DaemonVoiceModelCatalogContext';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';

function hasAncestor(
    node: ReactTestInstance,
    ancestor: ReactTestInstance,
): boolean {
    let parent = node.parent;
    while (parent) {
        if (parent === ancestor) return true;
        parent = parent.parent;
    }
    return false;
}

describe('DaemonModelPackRow', () => {
    it('keeps an accessible cancel action visible for the active install', async () => {
        const row: ModelCatalogRow = {
            packId: 'pack-active', kind: 'tts_sherpa', displayName: 'Active Pack', model: 'kokoro',
            state: 'downloading', progress: 0.5, lastError: null, loadedArtifactBytes: null,
            isDefault: false, canInstall: false, canRemove: false, licenseReview: null, sourcePluginId: null,
        };
        const onCancel = vi.fn();
        const { tree } = await renderScreen(
            <DaemonModelPackRow row={row} actionInFlight actionsDisabled
                onSetDefault={() => undefined} onInstall={() => undefined}
                onRemove={() => undefined} onCancel={onCancel} />,
        );
        const cancel = tree.root.findAllByProps({ testID: 'voice-model-cancel-pack-active' })
            .find((node) => String(node.type) === 'Pressable');
        expect(cancel).toBeTruthy();
        expect(cancel!.props.accessibilityRole).toBe('button');
        expect(cancel!.props.accessibilityLabel).toContain(t('common.cancel'));
        await pressTestInstanceAsync(cancel!);
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('delegates removal separately from selection through an accessible installed-pack control', async () => {
        const row: ModelCatalogRow = {
            packId: 'pack-1',
            kind: 'tts_sherpa',
            displayName: 'Pack One',
            model: 'kokoro',
            state: 'installed',
            progress: null,
            lastError: null,
            loadedArtifactBytes: null,
            isDefault: false,
            canInstall: false,
            canRemove: true,
            licenseReview: null,
            sourcePluginId: null,
        };
        const onRemove = vi.fn(async () => undefined);
        const onSetDefault = vi.fn();
        const { tree } = await renderScreen(
            <DaemonModelPackRow
                row={row}
                actionInFlight={false}
                onSetDefault={onSetDefault}
                onInstall={() => undefined}
                onRemove={onRemove}
            />,
        );

        const item = tree.root.findAll((node) => (
            node.props.testID === 'voice-model-row-pack-1'
            && node.props.title === 'Pack One'
            && node.props.rightElement !== undefined
        ))[0];
        if (!item) {
            throw new Error('Expected the rendered model-pack Item owner');
        }
        expect(item.props.rightElementOutsidePressable).toBe(true);

        const rowPressable = tree.root.findAllByProps({ testID: 'voice-model-row-pack-1' })
            .find((node) => String(node.type) === 'Pressable');
        const removeButton = tree.root.findAllByProps({ testID: 'voice-model-remove-pack-1' })
            .find((node) => String(node.type) === 'Pressable');
        expect(rowPressable).toBeTruthy();
        expect(removeButton).toBeTruthy();
        expect(hasAncestor(removeButton!, rowPressable!)).toBe(false);
        expect(removeButton?.props.accessibilityRole).toBe('button');
        expect(removeButton?.props.accessibilityLabel).toContain(t('common.remove'));
        expect(removeButton?.props.accessibilityLabel).toContain(row.displayName);
        expect(removeButton?.props.accessibilityLabel.trim()).not.toBe('');

        await pressTestInstanceAsync(removeButton!);
        expect(onRemove).toHaveBeenCalledWith('pack-1');
        expect(onSetDefault).not.toHaveBeenCalled();
    });

    it('keeps removal available for the installed default pack', async () => {
        const row: ModelCatalogRow = {
            packId: 'pack-default',
            kind: 'stt_sherpa',
            displayName: 'Default Pack',
            model: 'sherpa',
            state: 'ready',
            progress: null,
            lastError: null,
            loadedArtifactBytes: null,
            isDefault: true,
            canInstall: false,
            canRemove: true,
            licenseReview: null,
            sourcePluginId: null,
        };
        const onRemove = vi.fn(async () => undefined);
        const { tree } = await renderScreen(
            <DaemonModelPackRow
                row={row}
                actionInFlight={false}
                onSetDefault={() => undefined}
                onInstall={() => undefined}
                onRemove={onRemove}
            />,
        );

        await pressTestInstanceAsync(tree.root.findByProps({ testID: 'voice-model-remove-pack-default' }));
        expect(onRemove).toHaveBeenCalledWith('pack-default');
    });

    it('projects the canonical pack-local mutation failure into the selected-provider row', async () => {
        const entry = listModelPackCatalogEntries('stt_sherpa')[0]!;
        const status: DaemonVoiceInferenceModelStatus = {
            packId: entry.packId,
            pluginIdentity: null,
            kind: entry.kind,
            model: entry.model,
            version: null,
            executionSupport: ['daemon'],
            runtimeFamily: entry.runtimeFamily,
            runtimeSupported: true,
            installState: 'not_installed',
            progress: null,
            lastError: null,
            updatedAtMs: 0,
        };
        const controller = {
            state: {
                statuses: [status],
                errorCode: null,
                loading: false,
                actionPackId: null,
                actionError: {
                    packId: entry.packId,
                    operation: 'install' as const,
                    errorCode: 'internal_error' as const,
                },
            },
            refresh: vi.fn(async () => undefined),
            install: vi.fn(async () => undefined),
            remove: vi.fn(async () => undefined),
            cancel: vi.fn(),
        };

        const { tree } = await renderScreen(
            <DaemonVoiceModelCatalogProvider value={controller}>
                <SelectedDaemonModelPackRow packId={entry.packId} kind="stt_sherpa" />
            </DaemonVoiceModelCatalogProvider>,
        );

        expect(tree.root.findByProps({ testID: `voice-model-row-${entry.packId}` }).props.destructive).toBe(true);
    });

    it('renders the selected-provider row for the exact published q8 pack id', async () => {
        const canonicalPackId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const entry = listModelPackCatalogEntries('tts_sherpa')
            .find((candidate) => candidate.packId === canonicalPackId)!;
        const status: DaemonVoiceInferenceModelStatus = {
            packId: entry.packId,
            pluginIdentity: null,
            kind: entry.kind,
            model: entry.model,
            version: null,
            executionSupport: ['daemon'],
            runtimeFamily: entry.runtimeFamily,
            runtimeSupported: true,
            installState: 'installed',
            progress: null,
            lastError: null,
            updatedAtMs: 0,
        };
        const controller = {
            state: {
                statuses: [status],
                errorCode: null,
                loading: false,
                actionPackId: null,
                actionError: null,
            },
            refresh: vi.fn(async () => undefined),
            install: vi.fn(async () => undefined),
            remove: vi.fn(async () => undefined),
            cancel: vi.fn(),
        };

        const screen = await renderScreen(
            <DaemonVoiceModelCatalogProvider value={controller}>
                <SelectedDaemonModelPackRow
                    packId="kokoro-82m-v1.0-onnx-q8-wasm"
                    kind="tts_sherpa"
                    setting={VOICE_CONVERSATIONS_SETTINGS.settings.ttsAssetId}
                />
            </DaemonVoiceModelCatalogProvider>,
        );

        expect(screen.tree.root.findByProps({ testID: `voice-model-row-${canonicalPackId}` })).toBeTruthy();
        const anchor = `setting-${VOICE_CONVERSATIONS_SETTINGS.settings.ttsAssetId.anchor}`;
        expect(screen.tree.root.findAllByProps({ nativeID: anchor }).length).toBeGreaterThan(0);

        await act(async () => screen.update(
            <DaemonVoiceModelCatalogProvider value={null}>
                <SelectedDaemonModelPackRow packId={canonicalPackId} kind="tts_sherpa"
                    setting={VOICE_CONVERSATIONS_SETTINGS.settings.ttsAssetId} />
            </DaemonVoiceModelCatalogProvider>,
        ));
        expect(screen.tree.root.findAllByProps({ nativeID: anchor })).toHaveLength(0);
    });
});
