import * as executableRegistrations from './clientExecutableContributions';
import { describe, expect, it, vi } from 'vitest';
import {
    PluginContributesV2Schema,
    type PluginMachineExecutionOriginV1,
    type PluginProjectedActionV2,
} from '@happier-dev/protocol';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

import { createPluginReactNativeBundleCache } from './bundleCache';
import { createPluginUiCommonJsLoaderBackend } from './commonJsLoaderBackend';
import {
    createPluginUiClientExecutableComposition,
    createPluginUiClientExecutableRegistrationIndex,
    getPluginUiClientExecutableTargetAddressKey,
    resolvePluginUiClientActionRegistration,
    resolvePluginUiClientDragSourceRegistration,
    resolvePluginUiClientDropTargetRegistration,
    resolvePluginUiClientWorkItemsRegistration,
} from './clientExecutableContributions';
import {
    createPluginUiExecutableModuleHost,
    type PluginUiExecutableModuleHost,
} from './executableModuleHost';
import type {
    PluginReactNativeExecutableExport,
    PluginReactNativeLoaderBackend,
} from './loader';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY } from '@/sync/domains/plugins/ui/projectionUnion';

it('prepares the selected Account authentication registration and does not expose another Account custody', async () => {
    const accountAuthority = { kind: 'account' as const, serverId: 'home', accountId: 'account', custodyId: 'auth-release' };
    const hostAccountOrigin = { ...accountAuthority, sourceCustody: { kind: 'bundled_first_party' as const,
        packagedRuntime: { kind: 'source_declaration' as const, packageName: '@acme/preview' } } };
    const definition = PluginContributesV2Schema.parse({ connectedAccountDescriptors: [{ id: 'account', title: 'Account',
        authentication: { account: { artifactId: target.artifactId, exportName: target.exportName }, defaultModeId: 'device',
            modes: [{ id: 'device', kind: 'oauthDeviceCode', outcomeReconciliation: 'none' },
                { id: 'native', kind: 'oauthDeviceCode', outcomeReconciliation: 'none' }] } }] }).connectedAccountDescriptors[0]!;
    const descriptor = { id: definition.id, pluginId, occurrenceId: accountAuthority.custodyId, definition, hostAccountOrigin };
    const index = createPluginUiClientExecutableRegistrationIndex();
    const declared = { authentication: { modes: {} } };
    const runtime = {
        refresh: vi.fn<ConnectedAccountRuntime['refresh']>(),
        revoke: vi.fn<ConnectedAccountRuntime['revoke']>(),
        status: vi.fn<ConnectedAccountRuntime['status']>(),
        materialize: vi.fn<ConnectedAccountRuntime['materialize']>(),
        authentication: { modes: { device: { kind: 'oauthDeviceCode' as const,
        begin: async () => ({ status: 'awaitingDeviceAuthorization' as const, verificationUri: 'https://auth.example.test',
            userCode: 'ABCD', expiresAtMs: 90_000, pollIntervalMs: 5_000 }),
        poll: async () => ({ status: 'pending' as const, retryAfterMs: 5_000 }), cancel: async () => {} } } } } satisfies ConnectedAccountRuntime;
    const scope = index.createScope({ pluginId, contributes: { connectedAccountDescriptors: [definition] },
        target: { ...target, realm: 'account' }, executionOrigin: null, occurrenceId: accountAuthority.custodyId,
        pluginVersion: '1.0.0', authority: accountAuthority,
        lifecycle: { signal: new AbortController().signal, isCurrent: () => true },
        prepareRegistration: async registration => registration.family === 'connectedAccountDescriptors'
            ? { ...registration, value: runtime }
            : registration });
    scope.api.connectedAccounts.register('account', declared);
    scope.commit();
    try {
        const prepared = await executableRegistrations.resolvePluginUiAccountConnectedAccountRegistration({ descriptor,
            platform: 'web', reader: index });
        expect(Object.keys(prepared?.runtime.authentication.modes ?? {})).toEqual(['device']);
        expect(await executableRegistrations.resolvePluginUiAccountConnectedAccountRegistration({
            descriptor: { ...descriptor, hostAccountOrigin: { ...hostAccountOrigin, accountId: 'another-account' } },
            platform: 'web', reader: index })).toBeNull();
        await scope.unwind();
        expect(await executableRegistrations.resolvePluginUiAccountConnectedAccountRegistration({ descriptor,
            platform: 'web', reader: index })).toBeNull();
    } finally { await scope.unwind(); }
});

const pluginId = 'acme.preview';
    const target = Object.freeze({
    artifactId: 'client-runtime',
    exportName: 'activate',
    platform: 'web' as const,
});
const occurrenceId = 'preview-occurrence-12';
const hostUiApiRange = '^1.0.0';
const executionOrigin = Object.freeze({
    serverIdentityId: 'srv_server1',
    materializationRef: Object.freeze({
        machineId: 'machine-1',
        materializationId: 'materialization-1',
        pluginId,
    }),
}) satisfies PluginMachineExecutionOriginV1;
const identity: PluginReactNativeBundleCacheIdentity = Object.freeze({
    pluginId,
    contributionId: target.artifactId,
    artifactId: target.artifactId,
    artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    platform: 'web',
});
const authority = Object.freeze({
    serverId: 'server-1',
    machineId: 'machine-1',
});
const moduleReference = Object.freeze({
    exportName: target.exportName,
});

it('activates separately authored Account code through the existing host and retires its registration', async () => {
    const accountOrigin = { kind: 'account' as const, serverId: 'home', accountId: 'account', custodyId: 'release-1' };
    const accountTarget = { ...target, realm: 'account' as const };
    const contributes = { actions: [{ ...projectedClientAction(), execution: {
        target: 'account' as const, account: { artifactId: target.artifactId, exportName: target.exportName },
    } }] };
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({ identity, format: 'plainJs', bytes: new TextEncoder().encode(
        "exports.activate = function(api) { api.actions.register('open-preview', async function(input) { return { accountValue: input.value }; }); };",
    ) });
    const composition = createPluginUiClientExecutableComposition();
    const activation = { pluginId, contributes, target: accountTarget, executionOrigin: null, occurrenceId: accountOrigin.custodyId,
        hostUiApiRange, pluginVersion: '1.0.0', cache, identity, moduleReference,
        backend: createPluginUiCommonJsLoaderBackend(), authority: accountOrigin, isCurrent: () => true };
    try {
        expect(await composition.reconcile([activation])).toMatchObject([{ result: { ok: true } }]);
        const registration = composition.read({ family: 'actions', pluginId, localId: 'open-preview', target: accountTarget,
            executionOrigin: null, occurrenceId: accountOrigin.custodyId });
        expect(registration?.right.target.realm).toBe('account');
        const handler = registration?.registration.value;
        expect(typeof handler).toBe('function');
        if (typeof handler !== 'function') throw new Error('missing Account handler');
        // This fixture's authored callback takes only its input. Invoke the
        // opaque executable ABI without fabricating a host context.
        expect(await Reflect.apply(handler, undefined, [{ value: 'portable' }])).toEqual({ accountValue: 'portable' });
        const successor = { ...activation, authority: { ...accountOrigin, custodyId: 'release-2' }, occurrenceId: 'release-2' };
        expect(await composition.reconcile([successor])).toMatchObject([{ result: { ok: true } }]);
        expect(registration?.lifecycle.signal.aborted).toBe(true);
        expect(composition.read({ family: 'actions', pluginId, localId: 'open-preview', target: accountTarget,
            executionOrigin: null, occurrenceId: accountOrigin.custodyId })).toBeNull();
        expect(composition.read({ family: 'actions', pluginId, localId: 'open-preview', target: accountTarget,
            executionOrigin: null, occurrenceId: successor.occurrenceId })).not.toBeNull();
        await composition.retain([]);
        expect(composition.read({ family: 'actions', pluginId, localId: 'open-preview', target: accountTarget,
            executionOrigin: null, occurrenceId: accountOrigin.custodyId })).toBeNull();
    } finally {
        await composition.unload();
    }
});

it('keeps registration rights separate when two plugins use the same executable bytes', async () => {
    const accountTarget = { ...target, realm: 'account' as const };
    const contributes = PluginContributesV2Schema.parse({ actions: [{ id: 'run', title: 'Run', scopes: ['global'],
        surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe', execution: { target: 'account', account: {
            artifactId: target.artifactId, exportName: target.exportName,
        } } }] });
    const bytes = new TextEncoder().encode("exports.activate = function(api) { api.actions.register('run', async function() { return 'ran'; }); };");
    const cache = createPluginReactNativeBundleCache();
    const activations = ['acme.first-portable', 'acme.second-portable'].map(pluginId => {
        const exactIdentity = { ...identity, pluginId };
        cache.putInstalledArtifact({ identity: exactIdentity, bytes, format: 'plainJs' });
        const authority = { kind: 'account' as const, serverId: 'home', accountId: 'account', custodyId: `custody-${pluginId}` };
        return { pluginId, contributes, target: accountTarget, executionOrigin: null, occurrenceId: authority.custodyId,
            hostUiApiRange, pluginVersion: '1.0.0', cache, identity: exactIdentity, moduleReference,
            backend: createPluginUiCommonJsLoaderBackend(), authority, isCurrent: () => true };
    });
    const composition = createPluginUiClientExecutableComposition();
    try {
        const attempts = await composition.reconcile(activations);
        expect(attempts.map(attempt => attempt.result)).toEqual([{ ok: true }, { ok: true }]);
        for (const activation of activations) {
            expect(composition.read({ family: 'actions', pluginId: activation.pluginId, localId: 'run', target: accountTarget,
                executionOrigin: null, occurrenceId: activation.occurrenceId })).not.toBeNull();
        }
    } finally {
        await composition.unload();
    }
});

describe('getPluginUiClientExecutableTargetAddressKey', () => {
    it('partitions exact sources by custody without inventing materializations', async () => {
        const sourceOrigin = { serverIdentityId: executionOrigin.serverIdentityId,
            sourceRef: { pluginId, machineId: authority.machineId,
                sourceCustody: { kind: 'development' as const, registeredRootId: 'source-a' } } };
        const address = { pluginId, target, executionOrigin: sourceOrigin, authority };
        expect(getPluginUiClientExecutableTargetAddressKey(address)).not.toEqual(getPluginUiClientExecutableTargetAddressKey({
            ...address, executionOrigin: { ...sourceOrigin, sourceRef: { ...sourceOrigin.sourceRef,
                sourceCustody: { kind: 'development', registeredRootId: 'source-b' } } },
        }));
        const index = createPluginUiClientExecutableRegistrationIndex();
        const scope = index.createScope({ pluginId, contributes: actionOnlyContributes(), target, executionOrigin: sourceOrigin,
            occurrenceId, pluginVersion: '1.0.0', lifecycle: createLifecycle() });
        scope.api.actions.register('open-preview', async () => null);
        scope.commit();
        expect(index.read({ family: 'actions', pluginId, localId: 'open-preview', target,
            executionOrigin: sourceOrigin, occurrenceId })?.executionOrigin).toEqual(sourceOrigin);
        const sourceAction = { ...withCurrentAuthorization(projectedClientAction()), executionOrigin: sourceOrigin };
        const stampedAction = { ...sourceAction, [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: {
            machineId: authority.machineId, serverId: authority.serverId,
            phase: 'current', interactionEnabled: true, executionOrigin: sourceOrigin,
        } };
        expect(resolvePluginUiClientActionRegistration({ action: stampedAction, platform: target.platform, reader: index }))
            .toMatchObject({ registration: { executionOrigin: sourceOrigin }, pluginVersion: '1.0.0' });
        await scope.unwind();
    });
    it('keeps every executable target address field distinct', () => {
        const address = Object.freeze({
            pluginId,
            target,
            executionOrigin,
            authority,
        });

        const keys = [
            address,
            { ...address, pluginId: 'acme.other' },
            { ...address, target: { ...target, artifactId: 'other-runtime' } },
            { ...address, target: { ...target, exportName: 'otherActivate' } },
            { ...address, target: { ...target, platform: 'ios' as const } },
            { ...address, executionOrigin: { ...executionOrigin, serverIdentityId: 'srv_other' } },
            {
                ...address,
                executionOrigin: {
                    ...executionOrigin,
                    materializationRef: { ...executionOrigin.materializationRef, machineId: 'machine-2' },
                },
            },
            {
                ...address,
                executionOrigin: {
                    ...executionOrigin,
                    materializationRef: { ...executionOrigin.materializationRef, materializationId: 'materialization-2' },
                },
            },
            {
                ...address,
                executionOrigin: {
                    ...executionOrigin,
                    materializationRef: { ...executionOrigin.materializationRef, pluginId: 'acme.other' },
                },
            },
            { ...address, authority: { ...authority, serverId: 'server-2' } },
            { ...address, authority: { ...authority, machineId: 'machine-2' } },
            // An originless (bundled/development) target is its own address.
            { ...address, executionOrigin: null },
        ].map(getPluginUiClientExecutableTargetAddressKey);

        expect([...new Set(keys)]).toHaveLength(keys.length);
    });
});

const contributes = PluginContributesV2Schema.parse({
    actions: [{
        id: 'open-preview',
        title: 'Open preview',
        scopes: ['session'],
        surfaces: ['ui'],
        placementBindings: ['detailsPanel'],
        dangerLevel: 'safe',
        execution: {
            target: 'client',
            client: {
                artifactId: target.artifactId,
                exportName: target.exportName,
            },
            platforms: [target.platform],
        },
    }],
    voiceProviders: [{
        id: 'conversation',
        title: 'Synthetic Conversation',
        kind: 'conversation',
        roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
        platforms: [target.platform],
        capabilities: {
            turn: {
                cancelResponse: true,
                bargeIn: false,
                clearInput: true,
                resumption: 'resume',
                replay: 'stable_ids',
                exactMessage: true,
                interruptionPolicy: 'provider_immediate',
            },
        },
        client: {
            artifactId: target.artifactId,
            exportName: target.exportName,
        },
    }],
});

function projectedClientAction(): PluginProjectedActionV2 {
    const action = {
        id: 'open-preview',
        pluginId,
        occurrenceId,
        title: 'Open preview',
        scopes: ['session'],
        surfaces: ['ui'],
        execution: {
            target: 'client',
            client: {
                artifactId: target.artifactId,
                exportName: target.exportName,
            },
            platforms: [target.platform],
        },
        executionOrigin,
        placementBindings: ['detailsPanel'],
        priority: 0,
        dangerLevel: 'safe',
        available: true,
    } satisfies PluginProjectedActionV2;
    return Object.freeze(action);
}

function withCurrentAuthorization(action: PluginProjectedActionV2): PluginProjectedActionV2 {
    const authorization: NonNullable<PluginProjectedActionV2['authorization']> = {
        generation: {
            targetGeneration: action.occurrenceId,
            desiredGeneration: action.occurrenceId,
            appliedGeneration: action.occurrenceId,
        },
        resourceSelections: [],
        scopedGrants: [],
        serviceAvailability: [],
        operatingSystemAuthorization: [],
    };
    return Object.freeze({
        ...action,
        authorization,
    });
}

function actionOnlyContributes() {
    return PluginContributesV2Schema.parse({
        actions: [{
            id: 'open-preview',
            title: 'Open preview',
            scopes: ['session'],
            surfaces: ['ui'],
            placementBindings: ['detailsPanel'],
            dangerLevel: 'safe',
            execution: {
                target: 'client',
                client: {
                    artifactId: target.artifactId,
                    exportName: target.exportName,
                },
                platforms: [target.platform],
            },
        }],
    });
}

function createProviderLeaf() {
    return {
        kind: 'conversation' as const,
        protocol: {
            async prepare() {
                return { kind: 'prepared' as const, session: { config: {}, safeMetadata: null } };
            },
            decodeControl: () => [],
            encodeTurnControl: (action: string) => action === 'cancel_response' ? { type: 'cancel' } : null,
        },
        async createConnection() {
            let open = false;
            return {
                kind: 'sdk_handle' as const,
                async connect() { open = true; },
                async sendControl() {},
                controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                async close() { open = false; },
                state: () => open ? 'open' as const : 'closed' as const,
                currentProviderSessionId: () => null,
                playbackCursorMs: () => null,
                beginOutputInterruptionCandidate: () => 'unsupported' as const,
                resolveOutputInterruptionCandidate() {},
            };
        },
        encodeToolResults: () => [],
        encodeToolContinuation: (responseId: string) => ({ type: 'continue', responseId }),
        encodeContextUpdate: (text: string) => [{ type: 'context', text }],
        encodeTextTurn: (text: string) => [{ type: 'text', text }],
        async forgetProviderConversation() {},
        microphoneMode: 'provider_managed' as const,
        setInputMuted: () => {},
    };
}

function cacheWithIdentity() {
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({
        identity,
        bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
        format: 'plainJs',
    });
    return cache;
}

function backend(exported: PluginReactNativeExecutableExport): PluginReactNativeLoaderBackend {
    return Object.freeze({
        backendId: 'commonJs',
        available: true,
        loadInstalledBundle: vi.fn(async () => exported),
    });
}

function readRegistrationInput(family: 'actions' | 'voiceProviders', localId: string) {
    return Object.freeze({
        family,
        pluginId,
        localId,
        target,
        executionOrigin,
        occurrenceId,
    });
}

function createLifecycle() {
    const controller = new AbortController();
    return Object.freeze({
        signal: controller.signal,
        isCurrent: () => !controller.signal.aborted,
    });
}

describe('generic client executable contribution registration', () => {
    it('resolves external work items only for the current plugin occurrence and retires its read authority', async () => {
        const index = createPluginUiClientExecutableRegistrationIndex();
        const contributes = PluginContributesV2Schema.parse({ workItems: [{ id: 'work-items', client: { artifactId: target.artifactId, exportName: target.exportName }, platforms: ['web'] }] });
        const source = { id: `${pluginId}/work-items`, pluginId, pluginVersion: '1.0.0', occurrenceId, definition: contributes.workItems[0]!, executionOrigin };
        const scope = index.createScope({ pluginId, contributes, target, executionOrigin, occurrenceId, pluginVersion: '1.0.0', authority, lifecycle: createLifecycle() });
        let invalidation: (() => void) | undefined;
        let cleanupCount = 0;
        scope.api.workItems.register('work-items', {
            resolve: async ({ itemIds }) => Object.fromEntries(itemIds.map(id => [id, id === 'known' ? { title: 'Live issue', category: 'started', linkedSessions: [] } : null])),
            watch: (_request, onChange) => { invalidation = onChange; return () => { cleanupCount++; }; },
        });
        expect(resolvePluginUiClientWorkItemsRegistration({ source, platform: 'web', reader: index })).toBeNull();
        scope.commit();
        const resolved = resolvePluginUiClientWorkItemsRegistration({ source, platform: 'web', reader: index });
        let changes = 0;
        const stop = resolved?.runtime.watch?.({ serverId: authority.serverId, itemIds: ['known'] }, () => { changes++; });
        invalidation?.();
        expect(changes).toBe(1);
        expect(await resolved?.runtime.resolve({ serverId: authority.serverId, itemIds: ['known', 'unknown'] }, { signal: new AbortController().signal })).toEqual({ known: { title: 'Live issue', category: 'started', linkedSessions: [] }, unknown: null });
        await expect(resolved?.runtime.resolve({ serverId: 'foreign-home', itemIds: ['known'] }, { signal: new AbortController().signal })).rejects.toThrow();
        expect(resolvePluginUiClientWorkItemsRegistration({ source: { ...source, id: 'unknown.plugin/work-items', pluginId: 'unknown.plugin' }, platform: 'web', reader: index })).toBeNull();
        expect(resolvePluginUiClientWorkItemsRegistration({ source: { ...source, occurrenceId: 'retired' }, platform: 'web', reader: index })).toBeNull();
        expect(resolvePluginUiClientWorkItemsRegistration({ source, platform: 'ios', reader: index })).toBeNull();
        const retiring = scope.unwind();
        invalidation?.();
        stop?.();
        expect(changes).toBe(1);
        expect(cleanupCount).toBe(1);
        expect(resolvePluginUiClientWorkItemsRegistration({ source, platform: 'web', reader: index })).toBeNull();
        await expect(resolved?.runtime.resolve({ serverId: authority.serverId, itemIds: ['known'] }, { signal: new AbortController().signal })).rejects.toThrow();
        await retiring;
    });
    it('resolves synchronous entity callbacks only for committed exact occurrences and withdraws on retirement', async () => {
        const index = createPluginUiClientExecutableRegistrationIndex();
        const contributes = PluginContributesV2Schema.parse({
            dragSources: [{ id: 'issue', title: 'Issue', referenceSchema: { type: 'string' }, client: { artifactId: target.artifactId, exportName: target.exportName }, platforms: ['web'] }],
            dropTargets: [{ id: 'review', title: 'Review', acceptedKinds: ['session'], actions: [{ kind: 'host', actionId: 'session.open' }], client: { artifactId: target.artifactId, exportName: target.exportName }, platforms: ['web'] }],
        });
        const source = { id: `${pluginId}/issue`, pluginId, pluginVersion: '1.0.0', occurrenceId, definition: contributes.dragSources[0]!, executionOrigin };
        const dropTarget = { id: `${pluginId}/review`, pluginId, pluginVersion: '1.0.0', occurrenceId, definition: contributes.dropTargets[0]!, executionOrigin };
        const scope = index.createScope({ pluginId, contributes, target, executionOrigin, occurrenceId, pluginVersion: '1.0.0', lifecycle: createLifecycle() });
        scope.api.dragSources.register('issue', { describe: reference => ({ title: String(reference) }) });
        scope.api.dropTargets.register('review', { resolve: () => ({ status: 'refused', reason: { code: 'unavailable', message: 'Unavailable' } }) });
        expect(resolvePluginUiClientDragSourceRegistration({ source, platform: 'web', reader: index })).toBeNull();
        scope.commit();
        expect(resolvePluginUiClientDragSourceRegistration({ source, platform: 'web', reader: index })?.runtime.describe('Issue 1')).toEqual({ title: 'Issue 1' });
        expect(resolvePluginUiClientDropTargetRegistration({ target: dropTarget, platform: 'web', reader: index })?.runtime.resolve({ item: { kind: 'session', scope: { serverId: 'server-1', accountId: 'account-1' }, address: { serverId: 'server-1', sessionId: 'session-1' } }, destination: null, input: 'chooser', targetInput: null }).status).toBe('refused');
        expect(resolvePluginUiClientDragSourceRegistration({ source: { ...source, occurrenceId: 'retired' }, platform: 'web', reader: index })).toBeNull();
        expect(resolvePluginUiClientDropTargetRegistration({ target: dropTarget, platform: 'ios', reader: index })).toBeNull();
        const retirement = scope.unwind();
        expect(resolvePluginUiClientDragSourceRegistration({ source, platform: 'web', reader: index })).toBeNull();
        expect(resolvePluginUiClientDropTargetRegistration({ target: dropTarget, platform: 'web', reader: index })).toBeNull();
        await retirement;
    });
    it('resolves an Action only after its exact registration commits and retires it synchronously', async () => {
        const index = createPluginUiClientExecutableRegistrationIndex();
        const listener = vi.fn();
        const unsubscribe = index.subscribe(listener);
        const action = projectedClientAction();
        const authorizedAction = withCurrentAuthorization(action);
        const scope = index.createScope({
            pluginId,
            contributes: actionOnlyContributes(),
            target,
            executionOrigin,
            occurrenceId,
            pluginVersion: '1.0.0',
            lifecycle: createLifecycle(),
        });
        scope.api.actions.register('open-preview', async () => null);

        expect(resolvePluginUiClientActionRegistration({
            action,
            platform: target.platform,
            reader: index,
        })).toBeNull();

        scope.commit();

        expect(index.revision()).toBe(1);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(resolvePluginUiClientActionRegistration({
            action,
            platform: target.platform,
            reader: index,
        })).toBeNull();
        const reader = Object.freeze({
            read: vi.fn(index.read),
        });
        const resolvedRegistration = resolvePluginUiClientActionRegistration({
            action: authorizedAction,
            platform: target.platform,
            reader,
        });
        expect(resolvedRegistration).toMatchObject({
            pluginVersion: '1.0.0',
            handler: expect.any(Function),
        });
        expect(index.read({
            ...readRegistrationInput('actions', 'open-preview'),
            occurrenceId: 'preview-occurrence-retired',
        })).toBeNull();
        expect(resolvedRegistration).not.toHaveProperty('address');
        expect(reader.read).toHaveBeenCalledWith(readRegistrationInput('actions', 'open-preview'));
        expect(resolvePluginUiClientActionRegistration({
            action: authorizedAction,
            platform: 'ios',
            reader: index,
        })).toBeNull();

        const retirement = scope.unwind();
        expect(resolvePluginUiClientActionRegistration({
            action: authorizedAction,
            platform: target.platform,
            reader: index,
        })).toBeNull();
        await retirement;
        expect(index.revision()).toBe(2);
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
    });

    it('fails closed when a client Action registration has no installed version', async () => {
        const index = createPluginUiClientExecutableRegistrationIndex();
        const action = projectedClientAction();
        const scope = index.createScope({
            pluginId,
            contributes: actionOnlyContributes(),
            target,
            executionOrigin,
            occurrenceId,
            lifecycle: createLifecycle(),
        });
        scope.api.actions.register('open-preview', async () => null);
        scope.commit();

        expect(resolvePluginUiClientActionRegistration({
            action,
            platform: target.platform,
            reader: index,
        })).toBeNull();
        await scope.unwind();
    });

    it('captures the exact Action and Voice registrations in one scope', async () => {
        const index = createPluginUiClientExecutableRegistrationIndex();
        const scope = index.createScope({
            pluginId,
            contributes,
            target,
            executionOrigin,
            occurrenceId,
            lifecycle: createLifecycle(),
        });

        scope.api.actions.register('open-preview', async () => null);
        scope.api.voiceProviders.register('conversation', createProviderLeaf());

        scope.commit();
        expect(scope.registrations()).toHaveLength(2);
        expect(index.read(readRegistrationInput('voiceProviders', 'conversation'))?.right).toMatchObject({
            family: 'voiceProviders',
            localId: 'conversation',
            voiceProviderDeclaration: {
                id: 'conversation',
                kind: 'conversation',
            },
        });
        await scope.unwind();
    });

    it('activates one exact target once, publishes Actions and Voice atomically, and withdraws before cleanup', async () => {
        const index = createPluginUiClientExecutableRegistrationIndex();
        const host = createPluginUiExecutableModuleHost();
        const cleanup = vi.fn(async () => {});
        const lifecycle = createLifecycle();
        const activate = vi.fn((api: PluginClientApi) => {
            // The index cannot expose a partially staged registration to a
            // consumer while the one shared client module is still activating.
            expect(index.read(readRegistrationInput('actions', 'open-preview'))).toBeNull();
            api.actions.register('open-preview', async () => null);
            api.voiceProviders.register('conversation', createProviderLeaf());
            return cleanup;
        });

        await host.replaceAuthority(authority);
        const input = Object.freeze({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(activate),
            hostPlatform: target.platform,
            authority,
            createScope: () => index.createScope({
                pluginId,
                contributes,
                target,
                executionOrigin,
                occurrenceId,
                lifecycle,
            }),
        });

        await expect(host.activate(input)).resolves.toEqual({ ok: true });
        await expect(host.activate(input)).resolves.toEqual({ ok: true });
        expect(activate).toHaveBeenCalledTimes(1);

        const action = index.read(readRegistrationInput('actions', 'open-preview'));
        const voice = index.read(readRegistrationInput('voiceProviders', 'conversation'));
        expect(action).toMatchObject({
            registration: { family: 'actions', localId: 'open-preview' },
            target,
            executionOrigin,
            occurrenceId,
        });
        expect(voice).toMatchObject({
            registration: { family: 'voiceProviders', localId: 'conversation' },
            target,
            executionOrigin,
            occurrenceId,
        });
        expect(Object.isFrozen(action)).toBe(true);
        expect(Object.isFrozen(voice)).toBe(true);

        const retiring = host.replaceAuthority(null);
        expect(index.read(readRegistrationInput('actions', 'open-preview'))).toBeNull();
        expect(index.read(readRegistrationInput('voiceProviders', 'conversation'))).toBeNull();
        await retiring;
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('never publishes one family when its shared target misses another declared registration', async () => {
        const index = createPluginUiClientExecutableRegistrationIndex();
        const host = createPluginUiExecutableModuleHost();
        const lifecycle = createLifecycle();
        const activate = vi.fn((api: PluginClientApi) => {
            api.actions.register('open-preview', async () => null);
        });

        await host.replaceAuthority(authority);
        await expect(host.activate({
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(activate),
            hostPlatform: target.platform,
            authority,
            createScope: () => index.createScope({
                pluginId,
                contributes,
                target,
                executionOrigin,
                occurrenceId,
                lifecycle,
            }),
        })).resolves.toEqual({
            ok: false,
            code: 'activation_failed',
            diagnostics: ['activation_failed'],
        });

        expect(index.read(readRegistrationInput('actions', 'open-preview'))).toBeNull();
        expect(index.read(readRegistrationInput('voiceProviders', 'conversation'))).toBeNull();
    });

    it('retries failed plugin A without withdrawing or reactivating successful plugin B', async () => {
        const secondPluginId = 'acme.second-preview';
        const secondOccurrenceId = 'second-preview-occurrence-12';
        const secondTarget = Object.freeze({
            artifactId: 'second-runtime',
            exportName: 'activateSecond',
            platform: 'web' as const,
        });
        const secondOrigin: PluginMachineExecutionOriginV1 = Object.freeze({
            ...executionOrigin,
            materializationRef: Object.freeze({
                ...executionOrigin.materializationRef,
                pluginId: secondPluginId,
                materializationId: 'materialization-second',
            }),
        });
        const secondAuthority = authority;
        const secondIdentity: PluginReactNativeBundleCacheIdentity = Object.freeze({
            ...identity,
            pluginId: secondPluginId,
            contributionId: secondTarget.artifactId,
            artifactId: secondTarget.artifactId,
            artifactDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        });
        const actionOnlyContributes = PluginContributesV2Schema.parse({
            actions: [{
                id: 'open-preview',
                title: 'Open preview',
                scopes: ['session'],
                surfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
                execution: {
                    target: 'client',
                    client: {
                        artifactId: target.artifactId,
                        exportName: target.exportName,
                    },
                    platforms: [target.platform],
                },
            }],
        });
        const secondActionOnlyContributes = PluginContributesV2Schema.parse({
            actions: [{
                id: 'open-second',
                title: 'Open second',
                scopes: ['session'],
                surfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
                execution: {
                    target: 'client',
                    client: {
                        artifactId: secondTarget.artifactId,
                        exportName: secondTarget.exportName,
                    },
                    platforms: [secondTarget.platform],
                },
            }],
        });
        const firstCleanup = vi.fn(async () => {});
        const secondCleanup = vi.fn(async () => {});
        let failFirstActivation = true;
        const firstActivate = vi.fn((api: PluginClientApi) => {
            if (failFirstActivation) throw new Error('synthetic plugin A activation failure');
            api.actions.register('open-preview', async () => null);
            return firstCleanup;
        });
        const secondActivate = vi.fn((api: PluginClientApi) => {
            api.actions.register('open-second', async () => null);
            return secondCleanup;
        });
        const createExecutableHost = vi.fn(() => createPluginUiExecutableModuleHost());
        const composition = createPluginUiClientExecutableComposition({ createExecutableHost });
        const firstActivation = Object.freeze({
            pluginId,
            occurrenceId,
            hostUiApiRange,
            contributes: actionOnlyContributes,
            target,
            executionOrigin,
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(firstActivate),
            authority,
            isCurrent: () => true,
        });
        const secondActivation = Object.freeze({
            pluginId: secondPluginId,
            occurrenceId: secondOccurrenceId,
            hostUiApiRange,
            pluginVersion: '1.0.0',
            immutableGenerationId: 'managed-second-1',
            contributes: secondActionOnlyContributes,
            target: secondTarget,
            executionOrigin: secondOrigin,
            cache: (() => {
                const cache = createPluginReactNativeBundleCache();
                cache.putInstalledArtifact({
                    identity: secondIdentity,
                    bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
                    format: 'plainJs',
                });
                return cache;
            })(),
            identity: secondIdentity,
            moduleReference: Object.freeze({
                exportName: secondTarget.exportName,
            }),
            backend: backend(secondActivate),
            authority: secondAuthority,
            isCurrent: () => true,
        });

        await expect(composition.reconcile([firstActivation, secondActivation])).resolves.toEqual([
            expect.objectContaining({ result: expect.objectContaining({ ok: false, code: 'activation_failed' }) }),
            expect.objectContaining({ result: { ok: true } }),
        ]);
        expect(createExecutableHost).toHaveBeenCalledTimes(1);
        expect(firstActivate).toHaveBeenCalledTimes(1);
        expect(secondActivate).toHaveBeenCalledTimes(1);
        expect(composition.read(readRegistrationInput('actions', 'open-preview'))).toBeNull();
        expect(composition.read({
            family: 'actions',
            pluginId: secondPluginId,
            occurrenceId: secondOccurrenceId,
            localId: 'open-second',
            target: secondTarget,
            executionOrigin: secondOrigin,
        })).not.toBeNull();

        failFirstActivation = false;
        await expect(composition.reconcile([firstActivation, secondActivation])).resolves.toEqual([
            expect.objectContaining({ result: { ok: true }, reused: false }),
            expect.objectContaining({ result: { ok: true }, reused: true }),
        ]);
        expect(firstActivate).toHaveBeenCalledTimes(2);
        expect(secondActivate).toHaveBeenCalledTimes(1);
        const firstRegistration = composition.read(readRegistrationInput('actions', 'open-preview'));
        const secondRegistration = composition.read({
            family: 'actions',
            pluginId: secondPluginId,
            occurrenceId: secondOccurrenceId,
            localId: 'open-second',
            target: secondTarget,
            executionOrigin: secondOrigin,
        });
        expect(firstRegistration).not.toBeNull();
        expect(secondRegistration).not.toBeNull();

        const replacementOccurrenceId = 'preview-occurrence-13';
        const replacementFirstActivation = Object.freeze({
            ...firstActivation,
            occurrenceId: replacementOccurrenceId,
        });
        const unchangedSecondAtNewProjection = Object.freeze({
            ...secondActivation,
            immutableGenerationId: 'managed-second-2',
        });
        await expect(composition.reconcile([
            replacementFirstActivation,
            unchangedSecondAtNewProjection,
        ])).resolves.toEqual([
            expect.objectContaining({ result: { ok: true }, reused: false }),
            expect.objectContaining({ result: { ok: true }, reused: true }),
        ]);
        expect(firstRegistration?.lifecycle.signal.aborted).toBe(true);
        expect(composition.read(readRegistrationInput('actions', 'open-preview'))).toBeNull();
        expect(composition.read({
            ...readRegistrationInput('actions', 'open-preview'),
            occurrenceId: replacementOccurrenceId,
        })).not.toBeNull();
        expect(composition.read({
            family: 'actions',
            pluginId: secondPluginId,
            occurrenceId: secondOccurrenceId,
            localId: 'open-second',
            target: secondTarget,
            executionOrigin: secondOrigin,
        })).toBe(secondRegistration);
        expect(firstActivate).toHaveBeenCalledTimes(3);
        expect(secondActivate).toHaveBeenCalledTimes(1);

        const replacementRegistration = composition.read({
            ...readRegistrationInput('actions', 'open-preview'),
            occurrenceId: replacementOccurrenceId,
        });
        const retiring = composition.reconcile([unchangedSecondAtNewProjection]);
        expect(replacementRegistration?.lifecycle.signal.aborted).toBe(true);
        expect(replacementRegistration?.lifecycle.isCurrent()).toBe(false);
        expect(composition.read({
            family: 'actions',
            pluginId: secondPluginId,
            occurrenceId: secondOccurrenceId,
            localId: 'open-second',
            target: secondTarget,
            executionOrigin: secondOrigin,
        })).not.toBeNull();
        await retiring;
        expect(firstCleanup).toHaveBeenCalledTimes(2);
        expect(secondCleanup).not.toHaveBeenCalled();
    });

    it('keeps exact authority partitions live together and retires only the withdrawn origin', async () => {
        const firstContributes = PluginContributesV2Schema.parse({
            actions: [{
                id: 'open-preview',
                title: 'Open preview',
                scopes: ['session'],
                surfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
                execution: {
                    target: 'client',
                    client: {
                        artifactId: target.artifactId,
                        exportName: target.exportName,
                    },
                    platforms: [target.platform],
                },
            }],
        });
        const otherPluginId = 'acme.other-preview';
        const otherOccurrenceId = 'other-preview-occurrence-12';
        const otherTarget = Object.freeze({
            artifactId: 'other-client-runtime',
            exportName: 'activateOther',
            platform: 'web' as const,
        });
        const otherOrigin: PluginMachineExecutionOriginV1 = Object.freeze({
            serverIdentityId: 'srv_server1',
            materializationRef: Object.freeze({
                machineId: 'machine-2',
                materializationId: 'materialization-2',
                pluginId: otherPluginId,
            }),
        });
        const otherAuthority = Object.freeze({
            serverId: 'server-1',
            machineId: 'machine-2',
        });
        const otherIdentity: PluginReactNativeBundleCacheIdentity = Object.freeze({
            ...identity,
            pluginId: otherPluginId,
            contributionId: otherTarget.artifactId,
            artifactId: otherTarget.artifactId,
            artifactDigest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        });
        const otherContributes = PluginContributesV2Schema.parse({
            actions: [{
                id: 'open-other-preview',
                title: 'Open other preview',
                scopes: ['session'],
                surfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
                execution: {
                    target: 'client',
                    client: {
                        artifactId: otherTarget.artifactId,
                        exportName: otherTarget.exportName,
                    },
                    platforms: [otherTarget.platform],
                },
            }],
        });
        const firstCleanup = vi.fn(async () => {});
        const otherCleanup = vi.fn(async () => {});
        const firstActivate = vi.fn((api: PluginClientApi) => {
            api.actions.register('open-preview', async () => null);
            return firstCleanup;
        });
        const otherActivate = vi.fn((api: PluginClientApi) => {
            api.actions.register('open-other-preview', async () => null);
            return otherCleanup;
        });
        const composition = createPluginUiClientExecutableComposition({
            createExecutableHost: () => createPluginUiExecutableModuleHost(),
        });
        const firstActivation = Object.freeze({
            pluginId,
            occurrenceId,
            hostUiApiRange,
            contributes: firstContributes,
            target,
            executionOrigin,
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(firstActivate),
            authority,
            isCurrent: () => true,
        });
        const otherActivation = Object.freeze({
            pluginId: otherPluginId,
            occurrenceId: otherOccurrenceId,
            hostUiApiRange,
            contributes: otherContributes,
            target: otherTarget,
            executionOrigin: otherOrigin,
            cache: (() => {
                const cache = createPluginReactNativeBundleCache();
                cache.putInstalledArtifact({
                    identity: otherIdentity,
                    bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
                    format: 'plainJs',
                });
                return cache;
            })(),
            identity: otherIdentity,
            moduleReference: Object.freeze({
                exportName: otherTarget.exportName,
            }),
            backend: backend(otherActivate),
            authority: otherAuthority,
            isCurrent: () => true,
        });

        await expect(composition.reconcile([firstActivation, otherActivation])).resolves.toEqual([
            expect.objectContaining({ result: { ok: true } }),
            expect.objectContaining({ result: { ok: true } }),
        ]);
        const firstRegistration = composition.read(readRegistrationInput('actions', 'open-preview'));
        expect(firstRegistration).not.toBeNull();
        expect(composition.read({
            family: 'actions',
            pluginId: otherPluginId,
            occurrenceId: otherOccurrenceId,
            localId: 'open-other-preview',
            target: otherTarget,
            executionOrigin: otherOrigin,
        })).not.toBeNull();

        const retireFirstOrigin = composition.reconcile([otherActivation]);
        expect(firstRegistration?.lifecycle.signal.aborted).toBe(true);
        expect(composition.read(readRegistrationInput('actions', 'open-preview'))).toBeNull();
        expect(composition.read({
            family: 'actions',
            pluginId: otherPluginId,
            occurrenceId: otherOccurrenceId,
            localId: 'open-other-preview',
            target: otherTarget,
            executionOrigin: otherOrigin,
        })).not.toBeNull();
        await retireFirstOrigin;
        expect(firstCleanup).toHaveBeenCalledTimes(1);
        expect(otherCleanup).not.toHaveBeenCalled();

        await composition.unload();
        expect(otherCleanup).toHaveBeenCalledTimes(1);
    });

    it('retries an authority leaf after replaceAuthority rejects without poisoning the reusable host', async () => {
        const realHost = createPluginUiExecutableModuleHost();
        let replaceAttempts = 0;
        const flakyHost: PluginUiExecutableModuleHost = Object.freeze({
            ...realHost,
            replaceAuthority: async (nextAuthority) => {
                replaceAttempts += 1;
                if (replaceAttempts === 1) throw new Error('replace_authority_failed');
                await realHost.replaceAuthority(nextAuthority);
            },
        });
        const createExecutableHost = vi.fn(() => flakyHost);
        const activation = Object.freeze({
            pluginId,
            occurrenceId,
            hostUiApiRange,
            contributes,
            target,
            executionOrigin,
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend((api: PluginClientApi) => {
                api.actions.register('open-preview', async () => null);
                api.voiceProviders.register('conversation', createProviderLeaf());
            }),
            authority,
            isCurrent: () => true,
        });
        const composition = createPluginUiClientExecutableComposition({ createExecutableHost });

        await expect(composition.reconcile([activation])).rejects.toThrow('replace_authority_failed');
        await expect(composition.reconcile([activation])).resolves.toEqual([
            expect.objectContaining({ result: { ok: true } }),
        ]);

        expect(createExecutableHost).toHaveBeenCalledTimes(1);
        expect(replaceAttempts).toBe(2);
        await composition.unload();
    });

    it('remounts the same authority before retiring cleanup settles without letting that cleanup withdraw the new registration', async () => {
        const composition = createPluginUiClientExecutableComposition({
            executableHost: createPluginUiExecutableModuleHost(),
        });
        let releaseRetiringCleanup!: () => void;
        const retiringCleanup = new Promise<void>((resolve) => {
            releaseRetiringCleanup = resolve;
        });
        let activationCount = 0;
        const activate = vi.fn((api: PluginClientApi) => {
            activationCount += 1;
            api.actions.register('open-preview', async () => null);
            return activationCount === 1
                ? () => retiringCleanup
                : undefined;
        });
        const activation = Object.freeze({
            pluginId,
            occurrenceId,
            hostUiApiRange,
            contributes: actionOnlyContributes(),
            target,
            executionOrigin,
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(activate),
            authority,
            isCurrent: () => true,
        });
        const readRegistration = () => composition.read(readRegistrationInput('actions', 'open-preview'));

        await expect(composition.reconcile([activation])).resolves.toEqual([
            expect.objectContaining({ result: { ok: true } }),
        ]);
        expect(readRegistration()).not.toBeNull();

        const retiring = composition.unload();
        expect(readRegistration()).toBeNull();
        try {
            await expect(composition.reconcile([activation])).resolves.toEqual([
                expect.objectContaining({ result: { ok: true } }),
            ]);
            const remountedRegistration = readRegistration();
            expect(remountedRegistration).not.toBeNull();

            releaseRetiringCleanup();
            await retiring;

            expect(readRegistration()).toBe(remountedRegistration);
        } finally {
            releaseRetiringCleanup();
            await retiring;
            await composition.unload();
        }
    });

    it('withdraws every generic registration synchronously on plugin retirement', async () => {
        const composition = createPluginUiClientExecutableComposition({
            executableHost: createPluginUiExecutableModuleHost(),
        });
        const cleanup = vi.fn(async () => {});
        const activate = vi.fn((api: PluginClientApi) => {
            api.actions.register('open-preview', async () => null);
            return cleanup;
        });
        const actionOnlyContributes = PluginContributesV2Schema.parse({
            actions: [{
                id: 'open-preview',
                title: 'Open preview',
                scopes: ['session'],
                surfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
                execution: {
                    target: 'client',
                    client: {
                        artifactId: target.artifactId,
                        exportName: target.exportName,
                    },
                    platforms: [target.platform],
                },
            }],
        });
        const activation = Object.freeze({
            pluginId,
            occurrenceId,
            hostUiApiRange,
            contributes: actionOnlyContributes,
            target,
            executionOrigin,
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: backend(activate),
            authority,
            isCurrent: () => true,
        });

        await expect(composition.reconcile([activation])).resolves.toEqual([
            expect.objectContaining({ result: { ok: true } }),
        ]);
        const registration = composition.read(readRegistrationInput('actions', 'open-preview'));
        expect(registration).not.toBeNull();

        const retiring = composition.invalidatePlugin(pluginId);
        expect(registration?.lifecycle.signal.aborted).toBe(true);
        expect(composition.read(readRegistrationInput('actions', 'open-preview'))).toBeNull();
        await retiring;
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('cannot publish a module that finishes loading after its exact target retires', async () => {
        const composition = createPluginUiClientExecutableComposition({
            executableHost: createPluginUiExecutableModuleHost(),
        });
        const activate = vi.fn((api: PluginClientApi) => {
            api.actions.register('open-preview', async () => null);
        });
        let resolveLoaded: (exported: PluginReactNativeExecutableExport) => void = () => {};
        const loaded = new Promise<PluginReactNativeExecutableExport>((resolve) => {
            resolveLoaded = resolve;
        });
        const slowBackend: PluginReactNativeLoaderBackend = Object.freeze({
            backendId: 'commonJs',
            available: true,
            loadInstalledBundle: vi.fn(() => loaded),
        });
        const actionOnlyContributes = PluginContributesV2Schema.parse({
            actions: [{
                id: 'open-preview',
                title: 'Open preview',
                scopes: ['session'],
                surfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
                execution: {
                    target: 'client',
                    client: {
                        artifactId: target.artifactId,
                        exportName: target.exportName,
                    },
                    platforms: [target.platform],
                },
            }],
        });
        const activation = Object.freeze({
            pluginId,
            occurrenceId,
            hostUiApiRange,
            contributes: actionOnlyContributes,
            target,
            executionOrigin,
            cache: cacheWithIdentity(),
            identity,
            moduleReference,
            backend: slowBackend,
            authority,
            isCurrent: () => true,
        });

        const pending = composition.reconcile([activation]);
        await vi.waitFor(() => expect(slowBackend.loadInstalledBundle).toHaveBeenCalledTimes(1));
        const retiring = composition.reconcile([]);
        resolveLoaded(activate);

        await expect(pending).resolves.toEqual([
            expect.objectContaining({
                result: expect.objectContaining({
                    ok: false,
                    code: 'artifact_replaced',
                }),
            }),
        ]);
        expect(composition.read(readRegistrationInput('actions', 'open-preview'))).toBeNull();
        expect(activate).not.toHaveBeenCalled();
        await retiring;
    });
});
