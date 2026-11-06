import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { pressTestInstanceAsync, renderScreen, waitForTestEvent } from '@/dev/testkit';
import { t } from '@/text';
import { listModelPackCatalogEntries } from '@happier-dev/protocol';
import { DaemonVoiceInferenceModelStatusSchema,
    DaemonVoiceInferenceModelsInstallResponseSchema } from '@happier-dev/protocol/daemon/voiceInference';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { answerVoiceModelCatalogRpcRequest } from '@/dev/testkit/harness/voiceModelCatalogRpcBoundary';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

import type { ModelCatalogRow } from './buildModelCatalogRows';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
const account = createProviderSettingsAccountHarness();
let reply: Parameters<typeof installSessionActionRpcBoundary>[0] = () => { throw new Error('Unexpected model RPC'); };
installSessionActionRpcBoundary((request, context) => reply(request, context));
const { DaemonModelPackRow, SelectedDaemonModelPackRow } = await import('./DaemonModelPackRow');
const { DaemonVoiceModelCatalogProvider } = await import('./DaemonVoiceModelCatalogContext');
const { useDaemonVoiceModelCatalogState } = await import('./useDaemonVoiceModelCatalogState');
const { VOICE_CONVERSATIONS_SETTINGS } = await import('@/voice/settings/voiceSettingsDeclarations');

async function restoreModelAccount(waivedActions?: NonNullable<Parameters<typeof account.restore>[0]>['waivedActions']) {
    const machineId = 'model-row-machine';
    const scope = await account.restore({ waivedActions, settings: { experiments: true,
        featureToggles: { 'voice.agent': true, 'execution.runs': true, 'voice.daemonInference': true },
        voice: { executionMachine: { mode: 'fixed', machineId } } },
        machines: [createMachineFixture({ id: machineId, activeAt: Date.now() })],
        features: createRootLayoutFeaturesResponse({ features: {
            voice: { enabled: true },
            machines: { enabled: true, liveStream: { ...createRootLayoutFeaturesResponse().features.machines.liveStream, enabled: true, serverRouted: { enabled: true } } },
        }, capabilities: { machines: { ...createRootLayoutFeaturesResponse().capabilities.machines, liveStream: { serverRouted: { disabledReason: null, caps: {
            maxBitrateBps: 64_000, maxFramesPerSecond: 50, maxFrameBytes: 16_000, maxDurationMs: 60_000,
            maxTotalBytes: 1_000_000, maxConcurrentStreamsPerAccount: 2, maxConcurrentStreamsPerSocket: 1,
            maxConcurrentStreamsPerMachine: 1,
        } } } } } }),
    });
    const machine = createPlainMachineRowFixture({ id: machineId, accountId: scope.accountId });
    account.home.answer(scope.serverId, `/v1/machines/${machineId}`, { body: { machine } });
    account.home.answer(scope.serverId, `/v1/machines/${machineId}/access`, { body: { machineId,
        custodian: machine.access!.custodian, access: machine.access, canManage: true,
        grants: [], ownDirectGrant: false, ownAccessSources: [] } });
}

function SelectedRowOwner(props: Readonly<{ packId: string; kind: 'stt_sherpa' | 'tts_sherpa'; anchored?: boolean }>) {
    const controller = useDaemonVoiceModelCatalogState();
    return <DaemonVoiceModelCatalogProvider value={controller}>
        <SelectedDaemonModelPackRow packId={props.packId} kind={props.kind}
            setting={props.anchored ? VOICE_CONVERSATIONS_SETTINGS.settings.ttsAssetId : undefined} />
    </DaemonVoiceModelCatalogProvider>;
}

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
    afterEach(async () => { await account.reset(); vi.restoreAllMocks(); });
    it('says an unknown status once rather than as both the description and the value', async () => {
        const row: ModelCatalogRow = {
            packId: 'pack-unknown', kind: 'stt_sherpa', displayName: 'Unknown Pack', model: 'zipformer',
            state: 'unknown', progress: null, lastError: null, loadedArtifactBytes: null,
            languages: null, archiveBytes: null, inUse: null,
            canSetDefault: false,
            isDefault: false, canInstall: false, canRemove: false, licenseReview: null, sourcePluginId: null,
        };
        const screen = await renderScreen(
            <DaemonModelPackRow row={row} actionInFlight={false}
                onSetDefault={() => undefined} onInstall={() => undefined} onRemove={() => undefined} />,
        );
        // The value column already reads the state; the description must not repeat it.
        const item = screen.tree.root.findAll((node) => node.props.testID === 'voice-model-row-pack-unknown' && 'title' in node.props)[0];
        expect(item.props.detail).toBe(t('settingsVoice.local.models.state.unknown'));
        expect(item.props.subtitle).toBeUndefined();
    });

    it('lets Download say the model is missing, while a failed install keeps its state beside Retry', async () => {
        const base: ModelCatalogRow = {
            packId: 'pack-missing', kind: 'stt_sherpa', displayName: 'Parakeet', model: 'parakeet',
            state: 'not_installed', progress: null, lastError: null, loadedArtifactBytes: null,
            languages: ['en'], archiveBytes: 487_170_055, inUse: null, canSetDefault: false,
            isDefault: false, canInstall: true, canRemove: false, licenseReview: null, sourcePluginId: null,
        };
        const detailOf = async (row: ModelCatalogRow) => {
            const screen = await renderScreen(
                <DaemonModelPackRow row={row} actionInFlight={false}
                    onSetDefault={() => undefined} onInstall={() => undefined} onRemove={() => undefined} />,
            );
            return screen.tree.root.findAll((node) => node.props.testID === `voice-model-row-${row.packId}` && 'title' in node.props)[0].props.detail;
        };
        expect(await detailOf(base)).toBeUndefined();
        expect(await detailOf({ ...base, packId: 'pack-failed', state: 'error', lastError: 'Network lost' }))
            .toBe(t('settingsVoice.local.models.state.error'));
    });

    it('keeps an accessible cancel action visible for the active install', async () => {
        const row: ModelCatalogRow = {
            packId: 'pack-active', kind: 'tts_sherpa', displayName: 'Active Pack', model: 'kokoro',
            state: 'downloading', progress: 0.5, lastError: null, loadedArtifactBytes: null,
            languages: null, archiveBytes: null, inUse: null,
            canSetDefault: false,
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
            languages: null, archiveBytes: null, inUse: null,
            isDefault: false,
            canSetDefault: true,
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
            languages: null, archiveBytes: null, inUse: null,
            isDefault: true,
            canSetDefault: true,
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
        await restoreModelAccount();
        const entry = listModelPackCatalogEntries('stt_sherpa')[0]!;
        const status = DaemonVoiceInferenceModelStatusSchema.parse({
            packId: entry.packId, kind: entry.kind, model: entry.model, pluginIdentity: null,
            version: null, executionSupport: ['daemon'], runtimeFamily: entry.runtimeFamily,
            runtimeSupported: true, installState: 'not_installed', progress: null, lastError: null, updatedAtMs: 0,
        });
        reply = request => {
            const catalog = answerVoiceModelCatalogRpcRequest(request, [status]);
            if (catalog) return catalog;
            if (request.method.endsWith(':daemon.voiceInference.models.install')) return DaemonVoiceInferenceModelsInstallResponseSchema.parse({ ok: false, error: 'daemon model request failed', errorCode: 'internal_error' });
            throw new Error(`Unexpected model RPC: ${request.method}`);
        };
        const { tree } = await renderScreen(<SelectedRowOwner packId={entry.packId} kind="stt_sherpa" />);
        await waitForTestEvent(tree.subscribe, () => tree.root.findAllByProps({ testID: `voice-model-row-${entry.packId}` })[0]?.props.onPress, onPress => typeof onPress === 'function');
        expect(tree.root.findByProps({ testID: `voice-model-row-${entry.packId}` }).props.onPress).toBeTypeOf('function');
        await pressTestInstanceAsync(tree.root.findByProps({ testID: `voice-model-row-${entry.packId}` }));
        await waitForTestEvent(tree.subscribe, () => tree.root.findAllByProps({ testID: `voice-model-row-${entry.packId}` })[0]?.props.destructive, destructive => destructive === true);
        expect(tree.root.findByProps({ testID: `voice-model-row-${entry.packId}` }).props.destructive).toBe(true);
    });

    it('renders the selected-provider row for the exact published q8 pack id', async () => {
        await restoreModelAccount();
        const canonicalPackId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const entry = listModelPackCatalogEntries('tts_sherpa').find(candidate => candidate.packId === canonicalPackId)!;
        const status = DaemonVoiceInferenceModelStatusSchema.parse({
            packId: entry.packId, kind: entry.kind, model: entry.model, pluginIdentity: null,
            version: null, executionSupport: ['daemon'], runtimeFamily: entry.runtimeFamily,
            runtimeSupported: true, installState: 'installed', progress: null, lastError: null, updatedAtMs: 0,
        });
        reply = request => {
            const catalog = answerVoiceModelCatalogRpcRequest(request, [status]);
            if (catalog) return catalog;
            throw new Error(`Unexpected model RPC: ${request.method}`);
        };
        const screen = await renderScreen(<SelectedRowOwner packId={canonicalPackId} kind="tts_sherpa" anchored />);
        const anchor = `setting-${VOICE_CONVERSATIONS_SETTINGS.settings.ttsAssetId.anchor}`;
        await waitForTestEvent(screen.subscribe, () => screen.tree.root.findAllByProps({ testID: `voice-model-row-${canonicalPackId}` })[0]?.props.detail,
            detail => detail === t('settingsVoice.local.models.state.installed'));
        expect(screen.tree.root.findByProps({ testID: `voice-model-row-${canonicalPackId}` }).props.detail).toBe(t('settingsVoice.local.models.state.installed'));
        expect(screen.tree.root.findAllByProps({ nativeID: anchor }).length).toBeGreaterThan(0);
        await act(async () => screen.update(
            <DaemonVoiceModelCatalogProvider value={null}>
                <SelectedDaemonModelPackRow packId={canonicalPackId} kind="tts_sherpa"
                    setting={VOICE_CONVERSATIONS_SETTINGS.settings.ttsAssetId} />
            </DaemonVoiceModelCatalogProvider>,
        ));
        expect(screen.tree.root.findAllByProps({ nativeID: anchor })).toHaveLength(0);
    });

    it('updates an installed web Kokoro pack from its visible row and observes refreshed named voices', async () => {
        const { Platform } = await import('react-native');
        const previousPlatform = { ...Platform };
        Object.assign(Platform, (await (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock()).Platform);
        onTestFinished(() => { Object.assign(Platform, previousPlatform); });
        await restoreModelAccount(['settings.invoke']);
        const entry = listModelPackCatalogEntries('tts_sherpa').find(candidate => candidate.packId === 'kokoro-82m-v1.0-onnx-q8-wasm')!;
        let model = DaemonVoiceInferenceModelStatusSchema.parse({
            packId: entry.packId, kind: entry.kind, model: entry.model, pluginIdentity: null,
            version: 'retained', executionSupport: ['daemon'], runtimeFamily: entry.runtimeFamily,
            runtimeSupported: true, installState: 'installed', progress: null, lastError: null, updatedAtMs: 0,
            voices: [], defaultVoiceId: null,
        });
        let installs = 0;
        reply = request => {
            const catalog = answerVoiceModelCatalogRpcRequest(request, [model]);
            if (catalog) return catalog;
            if (request.method.endsWith(':daemon.voiceInference.models.install')) {
                installs += 1;
                model = DaemonVoiceInferenceModelStatusSchema.parse({ ...model,
                    voices: [{ id: 'af_maple', title: 'Maple' }], defaultVoiceId: 'af_maple' });
                return DaemonVoiceInferenceModelsInstallResponseSchema.parse({ ok: true, model });
            }
            throw new Error(`Unexpected model RPC: ${request.method}`);
        };
        const screen = await renderScreen(<SelectedRowOwner packId={entry.packId} kind="tts_sherpa" />);
        await waitForTestEvent(screen.subscribe, () => screen.tree.root.findAllByProps({ testID: `voice-model-row-${entry.packId}` })[0]?.props.detail,
            detail => detail === t('settingsVoice.local.models.state.installed'));
        const update = screen.tree.root.findAllByProps({ testID: `voice-model-install-${entry.packId}` })
            .find(node => String(node.type) === 'Pressable');
        expect(update, 'Installed web packs need a visible Update button').toBeTruthy();
        expect(update!.props.accessibilityLabel).toContain(t('common.update'));
        await pressTestInstanceAsync(update!);
        const { captureDaemonVoiceModelCatalogObservation } = await import('./daemonVoiceModelCatalogObservation');
        const observation = captureDaemonVoiceModelCatalogObservation('model-row-machine');
        await waitForTestEvent(observation.subscribe, () => observation.getSnapshot().statuses.find(row => row.packId === entry.packId)?.defaultVoiceId,
            id => id === 'af_maple');
        expect(installs).toBe(1);
        expect(observation.getSnapshot().statuses.find(row => row.packId === entry.packId)?.voices)
            .toEqual([expect.objectContaining({ id: 'af_maple' })]);
    });
});
