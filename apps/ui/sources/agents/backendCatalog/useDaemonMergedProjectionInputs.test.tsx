import { act } from 'react-test-renderer';
import * as React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { formatQualifiedPluginActionId} from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { ActionOperationDeclarationV1 } from '@happier-dev/protocol/actions/operations/v1';
import { createDeferred, createSessionFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import * as serverProfiles from '@/sync/domains/server/serverProfiles';

const daemonDescribe = vi.hoisted(() => vi.fn());
const homeIds = vi.hoisted(() => new Map<string, string>());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

// Install the real network boundary before loading Sync once. Per-case module
// reloads repeatedly cold-loaded the complete graph inside the hook deadline
// and detached cached transport factories from their boundary's request log.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
// The managed socket lazily imports this runtime. Finish that real startup
// module load before measuring unchanged summary reads, not during the loop.
await import('@/sync/domains/session/humanPresence/sessionHumanPresenceRuntime');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
const { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionCacheEntry, captureDaemonMergedProjectionReader } = await import('./loadDaemonMergedProjectionInputs');
const { useDaemonMergedProjectionInputs, useDaemonMergedProjectionSummary } = await import('./useDaemonMergedProjectionInputs');
const { storage } = await import('@/sync/domains/state/storage');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { createAccountTokenForTests, waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { useSessionRowActionMenu } = await import('@/components/sessions/shell/row/actionMenu/useSessionRowActionMenu');
const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
const { createListExtensionSource, createAccountSessionRowActionSource } = await import('../../../../../packages/plugin-sdk/fixtures/external-targeted-packages/list-extension-source');
afterAll(async () => { await network.dispose(); });

function readyResponse(generation: number) {
    return { protocolVersion: 1 as const, projection: { v: 2 as const, generation, familiesById: {} } };
}

function browserActionProjection(operation?: ActionOperationDeclarationV1) {
    const targetId = 'browserTarget:acme.preview:home-b';
    const actionId = 'browserAction:acme.preview:open-preview';
    return PluginProjectionV2Schema.parse({
        v: 2, generation: 7,
        actionsById: { 'acme.preview/open-preview': {
            id: 'open-preview', pluginId: 'acme.preview', occurrenceId: 'home-b-occurrence',
            title: 'Open preview', scopes: ['session'], surfaces: ['ui'],
            execution: { target: 'daemon' }, dangerLevel: 'safe', available: true,
            ...(operation ? { operation } : {}),
        } },
        familiesById: { pluginBrowser: { family: 'pluginBrowser', entriesById: {
            [targetId]: {
                id: targetId, pluginId: 'acme.preview', occurrenceId: 'home-b-occurrence',
                contributionKind: 'browserTarget', contributionId: 'home-b',
                target: { kind: 'externalUrl', targetId, url: 'https://home-b-preview.example.test/' },
                display: { title: 'Home B preview' }, currentUrl: 'https://home-b-preview.example.test/',
                launchMode: 'currentView', profileMode: 'session',
            },
            [actionId]: {
                id: actionId, pluginId: 'acme.preview', occurrenceId: 'home-b-occurrence',
                contributionKind: 'browserAction', contributionId: 'open-preview',
                qualifiedActionId: 'acme.preview/open-preview', targetId,
                placement: 'toolbar', display: { title: 'Open preview' },
            },
        } } },
    });
}

describe('useDaemonMergedProjectionInputs', () => {
    let serverId: string;
    let otherServerId: string;

    it('binds routed credentials only while projection demand is enabled', async () => {
        // The nonfocused Home has no active Sync connection; only this actual
        // projection consumer can demand its device credential in this case.
        const homeUrl = 'https://projection-hook-other.example.test';
        const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
        const targetCredentialReads = () => credentials.mock.calls.filter(([url]) => url === homeUrl).length;
        const hook = await renderHook<ReturnType<typeof useDaemonMergedProjectionInputs>, Readonly<{ enabled: boolean; machineId: string | null }>>(({ enabled, machineId }) => (
            useDaemonMergedProjectionInputs({ sections: 'complete', serverId: otherServerId, machineId, enabled })
        ), { initialProps: { enabled: false, machineId: 'machine-1' } });
        try {
            expect(hook.getCurrent()).toEqual({ phase: 'idle', inputs: null });
            expect.soft(targetCredentialReads()).toBe(0);
            await hook.rerender({ enabled: true, machineId: null });
            expect(hook.getCurrent().inputs).toBeNull();
            expect.soft(targetCredentialReads()).toBe(0);
            await hook.rerender({ enabled: true, machineId: 'machine-1' });
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready',
                inputs: { pluginProjectionV2: { generation: 1 } } }));
            expect(targetCredentialReads()).toBeGreaterThan(0);
            daemonDescribe.mockRejectedValueOnce(new RpcError('Private transport details', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE));
            await act(async () => publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId: otherServerId }, 'authority'));
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'error',
                failureReason: 'transport-unavailable', inputs: { pluginProjectionV2: { generation: 1 } } }));
            const boundReads = targetCredentialReads();
            await hook.rerender({ enabled: false, machineId: 'machine-1' });
            expect(hook.getCurrent()).toEqual({ phase: 'idle', inputs: null });
            expect(targetCredentialReads()).toBe(boundReads);
        } finally { await hook.unmount(); credentials.mockRestore(); }
    });

    it('rebinds a summary key on real Home correspondence publication without borrowing a foreign Home', async () => {
        await primeCache(7);
        const hook = await renderHook(() => useDaemonMergedProjectionSummary({ serverId, machineId: 'machine-1' }));
        try {
            expect(hook.getCurrent().current).toBe(true);
            await act(async () => {
                const learned = await serverProfiles.setServerProfileIdentityForUrl('https://projection-hook.example.test', 'srv_perf_b3_summary');
                expect(learned?.serverIdentityId).toBe('srv_perf_b3_summary');
            });
            expect(hook.getCurrent()).toMatchObject({ inputs: null, current: false });
            const { readDaemonMergedProjectionSummary } = await import('./loadDaemonMergedProjectionInputs');
            expect(readDaemonMergedProjectionSummary({ machineId: 'machine-1', serverId: otherServerId }))
                .toMatchObject({ inputs: null, current: false });
        } finally {
            await hook.unmount();
            await serverProfiles.removeServerProfile(serverId);
        }
    });

    beforeEach(async () => {
        network.resetRequests();
        storage.setState(storage.getInitialState(), true);
        daemonDescribe.mockReset();
        daemonDescribe.mockResolvedValue(readyResponse(1));
        // The network fixture publishes plain machine key markers. Admit the
        // same real Account mode before Sync restores its focused connection.
        network.setHttpResponder(async (input) => new URL(String(input)).pathname === '/v1/account/encryption'
            ? Response.json({ mode: 'plain', updatedAt: 1 })
            : null);
        const home = await network.addHome('https://projection-hook.example.test', 'account-a');
        const otherHome = await network.addHome('https://projection-hook-other.example.test', 'account-a');
        serverId = home.id;
        otherServerId = otherHome.id;
        homeIds.clear();
        homeIds.set(home.serverUrl, serverId);
        homeIds.set(otherHome.serverUrl, otherServerId);
        network.setRpcAckResponder(async (request) => {
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            }
            return { ok: true, result: await daemonDescribe({ machineId: request.targetId, serverId: homeIds.get(request.serverUrl), method: request.method, payload: request.payload }) };
        });
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        clearDaemonMergedProjectionCacheForTests();
    });
    afterEach(async () => {
        standardCleanup();
        clearDaemonMergedProjectionCacheForTests();
        await disconnectActiveServerConnection();
        await serverScopedRpcSocketPool.stopAll();
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
    });

    async function primeCache(generation: number, failRefresh = false) {
        daemonDescribe.mockResolvedValueOnce(readyResponse(generation));
        const scope = { machineId: 'machine-1', serverId };
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime).not.toBeNull();
        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...scope, accountLifetime });
        if (failRefresh) {
            daemonDescribe.mockRejectedValueOnce(new Error('Transport unavailable'));
            await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', ...scope, accountLifetime });
        }
        daemonDescribe.mockClear();
    }

    it('keeps unchanged projection reads at zero during Session streaming and still delivers real invalidation', async () => {
        const session = createSessionFixture({ id: 'projection-stream-session', serverId, owner: 'account-a' });
        storage.setState({ sessions: { [session.id]: session } });
        await primeCache(7);
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime).not.toBeNull();
        const observed: Array<ReturnType<typeof useDaemonMergedProjectionInputs>> = [];
        const peers: Array<ReturnType<typeof useDaemonMergedProjectionInputs>> = [];
        const hook = await renderHook((options: Readonly<{ sections?: readonly string[] }>) => {
            React.useSyncExternalStore(storage.subscribe, () => storage.getState().sessionMessages[session.id]);
            const params = { serverId, machineId: 'machine-1', accountLifetime,
                sections: options.sections ?? 'complete' as const };
            const snapshot = useDaemonMergedProjectionInputs(params);
            peers.push(useDaemonMergedProjectionInputs(params));
            observed.push(snapshot);
            return snapshot;
        }, { initialProps: {} });
        try {
            const initial = hook.getCurrent();
            expect(initial).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 7 } } });
            expect(new Set(observed).size).toBe(1);
            expect(observed).toHaveLength(1);
            for (let revisit = 0; revisit < 3; revisit++) {
                await hook.rerender();
                expect(hook.getCurrent()).toBe(initial);
            }
            expect(daemonDescribe).not.toHaveBeenCalled();

            const settledRenders = observed.length;
            for (let chunk = 0; chunk < 5; chunk++) {
                await act(async () => {
                    storage.getState().applyMessages(session.id, [{
                        id: `stream-${chunk}`, localId: `stream-${chunk}`, createdAt: chunk + 1,
                        isSidechain: false, role: 'agent',
                        content: [{ type: 'text', text: `Streaming chunk ${chunk}`, uuid: `stream-${chunk}`, parentUUID: null }],
                    }]);
                });
                expect(hook.getCurrent()).toBe(initial);
            }
            expect(observed.length).toBeGreaterThan(settledRenders);
            expect(daemonDescribe).not.toHaveBeenCalled();

            // A changed section request may share the full cached inputs, but
            // its render-time scope fence must still settle after commit.
            await hook.rerender({ sections: [] });
            expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: initial.inputs });
            expect(daemonDescribe).not.toHaveBeenCalled();

            const changed = createDeferred<ReturnType<typeof readyResponse>>();
            daemonDescribe.mockReturnValueOnce(changed.promise);
            await act(async () => publishMachineContributionRegistryProjectionInvalidation({ serverId, machineId: 'machine-1' }, 'authority'));
            expect(hook.getCurrent()).toMatchObject({ phase: 'loading', inputs: initial.inputs });
            await act(async () => { changed.resolve(readyResponse(8)); });
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({
                phase: 'ready', inputs: { pluginProjectionV2: { generation: 8 } },
            }));
            expect(hook.getCurrent().inputs).not.toBe(initial.inputs);
            expect(peers.at(-1)?.inputs).toBe(hook.getCurrent().inputs);
            expect(daemonDescribe).toHaveBeenCalledTimes(1);
        } finally { await hook.unmount(); }
    });

    async function adoptRowActionHome() {
        const serverIdentityId = 'srv_session_row_menu';
        // Restore the adopted Home through the actual connection owner. Merely
        // editing its profile leaves the applied runtime on the old alias.
        await disconnectActiveServerConnection();
        const adopted = await network.addHome('https://projection-hook.example.test', 'account-a', { serverIdentityId });
        serverId = adopted.id;
        homeIds.set(adopted.serverUrl, serverId);
        await upsertAndActivateServer({ serverUrl: adopted.serverUrl });
        await restoreConnectionToActiveServer({ token: adopted.token });
        return serverIdentityId;
    }

    async function answerRowSession(session: ReturnType<typeof createSessionFixture>, options?: Readonly<{ withoutMachines?: boolean }>) {
        const { createPlainSessionByIdResponseFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { buildSessionTurnsProjectionV1 } = await import('@happier-dev/protocol/sessions/turns/sessionTurnV1');
        network.setHttpResponder(async url => {
            const path = new URL(String(url)).pathname;
            if (options?.withoutMachines && path === '/v1/machines') return Response.json([]);
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === `/v2/sessions/${session.id}`) return Response.json(createPlainSessionByIdResponseFixture(session));
            if (path === `/v1/sessions/${session.id}/turns`) return Response.json(buildSessionTurnsProjectionV1({
                sessionId: session.id, updatedAt: 1, turns: [],
            }));
            return null;
        });
    }

    it.each(['direct', 'form'] as const)('invokes an admitted external Account row Action without any Machine (%s)', async mode => {
        // Restoring the Home starts Sync; keep its census empty before it can
        // republish the network boundary's default own Machine after store setup.
        network.setHttpResponder(async input => new URL(String(input)).pathname === '/v1/machines'
            ? Response.json([]) : null);
        await adoptRowActionHome();
        const session = createSessionFixture({ id: 'account-row-session', serverId, owner: 'account-a', metadata: null });
        storage.setState({ sessions: { [session.id]: session }, machines: {}, machineListByServerId: {} });
        await answerRowSession(session, { withoutMachines: true });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected the restored Account');
        const effects: string[] = [];
        const authored = createAccountSessionRowActionSource(sessionId => effects.push(sessionId), mode === 'form');
        const { installPortableAccountPluginForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
        const installed = await installPortableAccountPluginForTest({ manifest: authored.manifest,
            activate: authored.activateAccount, accountLifetime: lifetime });
        const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
        const unpublish = publishCommittedAppShellPluginUiProjection(() => installed.projection);
        const target = createSessionActionTarget({ session, serverId, currentUserId: 'account-a', isConnected: true });
        const tags: readonly string[] = [];
        const { Modal } = await import('@/modal');
        const forms: unknown[] = [];
        // Modal presentation is the system boundary; Account registration and
        // form schema/currentness/dispatch remain the real owners.
        const unregisterModal = Modal.registerProvider({ showModal: config => {
            if (config.type === 'custom' && 'props' in config && config.props && typeof config.props === 'object'
                && 'form' in config.props) forms.push(config.props.form);
            return 'account-row-action-modal';
        }, hideModal: () => {}, hideAllModals: () => {}, updateCustomModalProps: () => {} });
        const hook = await renderHook(() => useSessionRowActionMenu({ target, sessionName: 'Account review',
            hideInactiveSessions: false, iconColor: '#000000', activeTags: tags, knownTags: tags, tagsEnabled: false,
            menuOpen: true, touchPrimaryPointer: false, setContextMenuOpen: () => {}, openTagsMenuFromContext: () => {} }));
        try {
            const actionId = `${authored.manifest.id}/inspect`;
            await vi.waitFor(() => expect(hook.getCurrent().moreMenuItems.filter(item => item.id === actionId)).toHaveLength(1));
            await act(async () => hook.getCurrent().handleMoreMenuSelect(actionId));
            if (mode === 'form') {
                expect(forms).toHaveLength(1);
                const form = forms[0];
                if (!form || typeof form !== 'object'
                    || !('getInput' in form) || typeof form.getInput !== 'function'
                    || !('submit' in form) || typeof form.submit !== 'function') {
                    throw new Error('Expected the presented Account Action form');
                }
                const { getInput, submit } = form;
                const input: unknown = getInput.call(form);
                expect(input).toEqual({ sessionId: session.id });
                await act(async () => {
                    const result: unknown = await submit.call(form);
                    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'settled', outcome: { ok: true } });
                });
            }
            expect(effects).toEqual([session.id]);
            expect(daemonDescribe).not.toHaveBeenCalled();
        } finally { await hook.unmount(); unpublish(); await installed.dispose(); unregisterModal(); }
    });

    it.each(['direct', 'form'] as const)('admits external Session row Actions from the real projection and dispatches the qualified row once (%s)', async mode => {
        const authored = createListExtensionSource();
        const declared = authored.manifest.contributes.actions?.find(action => action.id === 'inspect');
        if (!declared) throw new Error('missing_external_inspect_declaration');
        const actionId = `${authored.manifest.id}/${declared.id}`;
        // captureBoundMachineRpcContent now reuses Sync's admitted mode;
        // match the Plain row produced by fetchAndApplyMachines.
        const machine = createMachineFixture({ storageMode: 'plain' });
        const serverIdentityId = await adoptRowActionHome();
        const executionOrigin = { serverIdentityId, sourceRef: { pluginId: authored.manifest.id, machineId: machine.id,
            sourceCustody: { kind: 'managed' as const, immutableGenerationId: 'release-source', installSource: 'localPath' as const } } };
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 23,
            installedPackagesById: { [authored.manifest.id]: { id: authored.manifest.id, displayName: 'Release tools',
                version: authored.manifest.version, enabled: true, immutableGenerationId: 'release-source',
                occurrenceId: 'release-source', executionOrigin, sourceCustody: executionOrigin.sourceRef.sourceCustody,
                source: { kind: 'path', locator: '/external/release-tools' } } },
            actionsById: { [actionId]: { id: declared.id, pluginId: authored.manifest.id, occurrenceId: 'release-source',
                title: declared.title, scopes: declared.scopes, surfaces: declared.surfaces,
                placementBindings: declared.placementBindings, sessionTarget: declared.sessionTarget,
                executionOrigin,
                ...(mode === 'form' ? { inputHints: { fields: [{ path: 'sessionId', title: 'Session', widget: 'text', required: true }] } } : {}),
                execution: declared.execution, dangerLevel: declared.dangerLevel, available: true } },
        });
        const session = createSessionFixture({ id: 'menu-session', serverId, owner: 'account-a', active: true });
        storage.setState({ sessions: { [session.id]: session }, machines: { [machine.id]: machine },
            machineListByServerId: { [serverId]: [machine] } });
        const { readMachineControlTargetForSession } = await import('@/sync/ops/sessionMachineTarget');
        expect(readMachineControlTargetForSession({ serverId, sessionId: session.id })?.machineId).toBe(machine.id);
        daemonDescribe.mockResolvedValue({ protocolVersion: 1, projection });
        const executed: unknown[] = [];
        network.setRpcAckResponder(async request => {
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: true, result: await daemonDescribe(request) };
            }
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return { ok: true,
                result: { ok: true, inputSchema: declared.inputSchema ?? {} } };
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                executed.push(request.payload);
                return { ok: true, result: { ok: true, result: { inspected: true, sessionId: session.id } } };
            }
            return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        });
        const target = createSessionActionTarget({ session, serverId, currentUserId: 'account-a', isConnected: true });
        await answerRowSession(session);
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const targetPreview = await createDefaultActionExecutor().previewSessionTargets({ selector: 'self', of: session.id }, {
            surface: 'ui', serverId, expectedAccountId: 'account-a', defaultSessionId: session.id,
        });
        expect(targetPreview, JSON.stringify({ targetPreview,
            paths: network.httpRequests.map(request => new URL(request.url).pathname),
        })).toMatchObject({ coverage: 'complete', addresses: [{ serverId, sessionId: session.id }], error: null });
        // The existing AppShell producer holds the Machine projection before
        // a row asks for its admitted declarations. The row never loads it.
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Expected the restored Account');
        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', serverId, machineId: machine.id, accountLifetime });
        daemonDescribe.mockClear();
        const { readCachedDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const { unionPluginUiProjections } = await import('@/sync/domains/plugins/ui/projectionUnion');
        const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
        const { createCurrentUiContextVoiceToolPort } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
        const { registerCurrentUiContextActionPort } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
        let unregisterProjection: (() => void) | undefined;
        let unregisterPort: (() => void) | undefined;
        const { Modal } = await import('@/modal');
        const presentedForms: unknown[] = [];
        // The modal host is the native/web presentation boundary; the form,
        // its currentness and canonical submit dispatcher remain real.
        const unregisterModal = Modal.registerProvider({
            showModal: config => {
                if (config.type === 'custom' && 'props' in config && config.props && typeof config.props === 'object'
                    && 'form' in config.props) {
                    presentedForms.push(config.props.form);
                }
                return 'session-row-action-modal';
            }, hideModal: () => {}, hideAllModals: () => {}, updateCustomModalProps: () => {},
        });
        const hook = await renderHook(() => {
            const [open, setOpen] = React.useState(false);
            const [mobile, setMobile] = React.useState(false);
            return { ...useSessionRowActionMenu({
                target, sessionName: 'Release review', hideInactiveSessions: false, iconColor: '#000000',
                activeTags: [], knownTags: [], tagsEnabled: false, menuOpen: open, touchPrimaryPointer: mobile,
                setContextMenuOpen: setOpen, openTagsMenuFromContext: () => {},
            }), setOpen, setMobile };
        });
        try {
            expect(daemonDescribe).not.toHaveBeenCalled();
            await act(async () => hook.getCurrent().setOpen(true));
            await vi.waitFor(() => {
                const entry = readCachedDaemonMergedProjectionCacheEntry({ serverId, machineId: machine.id });
                expect(entry?.kind, entry?.kind === 'error' ? entry.reason : undefined).toBe('ready');
            });
            await flushHookEffects({ cycles: 3, turns: 2 });
            // A daemon declaration alone is not Account source admission.
            if (mode === 'direct') expect(hook.getCurrent().moreMenuItems.map(item => item.id)).not.toContain(actionId);
            // The ordinary front door borrows the real AppShell Action port,
            // which consumes the same admitted Machine projection. No second
            // test executor or mocked Action catalog may stand in for it.
            const cached = readCachedDaemonMergedProjectionCacheEntry({ serverId, machineId: machine.id });
            if (cached?.kind !== 'ready') throw new Error('Expected the admitted row projection');
            // This Account selected the exact available source. The union
            // consumes that Administration fact; it must not elect a source.
            const union = unionPluginUiProjections([{ serverId, machineId: machine.id,
                serverIdentityId, projection: cached.inputs.pluginUiProjection, phase: 'current', interactionEnabled: true,
                selectableExecutionOrigins: [executionOrigin],
            }], new Map([[authored.manifest.id, executionOrigin]]));
            await act(async () => { unregisterProjection = publishCommittedAppShellPluginUiProjection(() => union.pluginUiProjection); });
            expect(createCurrentUiContextVoiceToolPort({ invocationSurface: 'ui', readProjection: () => union.pluginUiProjection,
                readNavigationBinding: () => null, reader: { readCurrentUiContext: () => null,
                    resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
            }).listCurrentContributedActionDefinitions?.('allSurfaces').map(action => action.id))
                .toContain(formatQualifiedPluginActionId({ pluginId: authored.manifest.id, localId: declared.id }));
            unregisterPort = registerCurrentUiContextActionPort((invocationSurface, hostAction) => createCurrentUiContextVoiceToolPort({
                invocationSurface, hostAction, readProjection: () => union.pluginUiProjection, readNavigationBinding: () => null,
                reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
            }));
            await vi.waitFor(() => expect(hook.getCurrent().moreMenuItems.filter(item => item.id === actionId)).toHaveLength(1));
            const selectPublishedAction = hook.getCurrent().handleMoreMenuSelect;
            await act(async () => hook.getCurrent().setMobile(true));
            expect(hook.getCurrent().contextMenuItems.filter(item => item.id === actionId)).toHaveLength(1);
            await act(async () => hook.getCurrent().handleContextMenuSelect(actionId));
            if (mode === 'form') {
                await vi.waitFor(() => expect(presentedForms).toHaveLength(1));
                await flushHookEffects({ cycles: 3, turns: 2 });
                const form = presentedForms[0];
                if (!form || typeof form !== 'object'
                    || !('getInput' in form) || typeof form.getInput !== 'function'
                    || !('submit' in form) || typeof form.submit !== 'function'
                    || !('isRetired' in form) || typeof form.isRetired !== 'function'
                    || !('retire' in form) || typeof form.retire !== 'function') {
                    throw new Error('Expected the presented Session Action form');
                }
                const { getInput, submit, isRetired, retire } = form;
                const retired: unknown = isRetired.call(form);
                const input: unknown = getInput.call(form);
                expect(retired).toBe(false);
                expect(input).toEqual({ sessionId: session.id });
                expect(executed).toEqual([]);
                await act(async () => {
                    const settled: unknown = await submit.call(form);
                    expect(settled, JSON.stringify(settled)).toMatchObject({ kind: 'settled', outcome: { ok: true } });
                });
                await act(async () => { retire.call(form); });
            }
            await vi.waitFor(() => expect(executed).toHaveLength(1));
            expect(executed).toMatchObject([{ machineId: machine.id, qualifiedActionId: actionId,
                input: { sessionId: session.id }, sessionId: session.id, executionSurface: 'ui' }]);
            await act(async () => { unregisterProjection?.(); unregisterProjection = undefined; });
            await act(async () => hook.getCurrent().setOpen(false));
            await selectPublishedAction(actionId);
            expect(executed).toHaveLength(1);
        } finally { unregisterPort?.(); unregisterProjection?.(); await hook.unmount(); unregisterModal(); }
    });

    it('keeps closed Session menus inert across a thousand-row corpus and unrelated arrivals', async () => {
        const sessions = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => {
            const session = createSessionFixture({ id: `cost-session-${index}`, owner: 'account-a' });
            return [session.id, session];
        }));
        storage.setState({ sessions });
        const target = createSessionActionTarget({ session: sessions['cost-session-0']!, serverId,
            currentUserId: 'account-a', isConnected: true });
        const activeTags: readonly string[] = [];
        let renders = 0;
        const hook = await renderHook(() => {
            renders++;
            return useSessionRowActionMenu({ target, sessionName: 'Release review', hideInactiveSessions: false,
                iconColor: '#000000', activeTags, knownTags: activeTags, tagsEnabled: false, menuOpen: false,
                touchPrimaryPointer: false, setContextMenuOpen: () => {}, openTagsMenuFromContext: () => {} });
        });
        try {
            const settledRenders = renders;
            const firstItems = hook.getCurrent().moreMenuItems;
            for (let index = 0; index < 5; index++) await act(async () => storage.setState({ sessions: {
                ...storage.getState().sessions, [`arrival-${index}`]: createSessionFixture({ id: `arrival-${index}` }),
            } }));
            const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
            let unpublish: (() => void) | undefined;
            try {
                await act(async () => { unpublish = publishCommittedAppShellPluginUiProjection(() => null); });
            } finally { await act(async () => unpublish?.()); }
            expect(renders - settledRenders).toBe(0);
            expect(hook.getCurrent().moreMenuItems).toBe(firstItems);
            expect(daemonDescribe).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('retries an unanswered read after effect supersession and after its final mounted reader leaves', async () => {
        daemonDescribe.mockImplementationOnce(() => new Promise(() => {}));
        daemonDescribe.mockResolvedValueOnce(readyResponse(2));
        const hook = await renderHook(({ machineId, refreshKey }: { machineId: string; refreshKey: number }) => (
            useDaemonMergedProjectionInputs({ sections: 'complete', machineId, serverId, refreshKey })
        ), { initialProps: { machineId: 'machine-1', refreshKey: 0 } });
        await vi.waitFor(() => expect(daemonDescribe).toHaveBeenCalledTimes(1));
        expect(hook.getCurrent().phase).toBe('loading');
        await hook.rerender({ machineId: 'machine-1', refreshKey: 1 });
        await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
        expect(daemonDescribe).toHaveBeenCalledTimes(2);

        daemonDescribe.mockImplementationOnce(() => new Promise(() => {}));
        await hook.rerender({ machineId: 'machine-2', refreshKey: 1 });
        await vi.waitFor(() => expect(daemonDescribe).toHaveBeenCalledTimes(3));
        await hook.unmount();
        daemonDescribe.mockResolvedValueOnce(readyResponse(3));
        const reopened = await renderHook(() => useDaemonMergedProjectionInputs({ sections: 'complete', machineId: 'machine-2', serverId }));
        try {
            await vi.waitFor(() => expect(reopened.getCurrent().phase).toBe('ready'));
            expect(daemonDescribe).toHaveBeenCalledTimes(4);
        } finally { await reopened.unmount(); }
    });

    async function settledHook() {
        const hook = await renderHook(() => useDaemonMergedProjectionInputs({ sections: 'complete', machineId: 'machine-1', serverId }));
        await flushHookEffects({ cycles: 3, turns: 2 });
        await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
        return hook;
    }

    async function writeRealHomeCredentials(homeB: Readonly<{ id: string; serverUrl: string; token: string }>) {
        // Restore the real credential reader: native storage remains the only
        // credential boundary beneath real parsing, binding and mutation.
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockRestore();
        expect(await TokenStorage.setCredentialsForServerUrl('https://projection-hook.example.test', { serverId }, {
            token: createAccountTokenForTests('account-a'),
        })).toBe(true);
        expect(await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, {
            token: homeB.token,
        })).toBe(true);
    }

    it('admits a nonfocused Home Browser projection through that Home’s distinct Account credentials', async () => {
        const homeB = await network.addHome('https://projection-browser-home-b.example.test', 'account-b');
        homeIds.set(homeB.serverUrl, homeB.id);
        await writeRealHomeCredentials(homeB);
        const { storage, useEndpointStatus, useMachineCliDetectionTarget } = await import('@/sync/domains/state/storage');
        const { prepareWarmCacheEncryptionKey } = await import('@/sync/domains/state/warmCacheEncryptionKey');
        const { usePluginUiProjectionCurrentness } = await import('@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness');
        const { parseToken } = await import('@/utils/auth/parseToken');
        const { isMachineOnline } = await import('@/utils/sessions/machineUtils');
        const { resolveServerScopedMachine } = await import('@/sync/domains/machines/resolveServerScopedMachine');
        const { readCachedDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
        const { getMachineContributionRegistryProjectionRevision } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
        await prepareWarmCacheEncryptionKey();
        storage.getState().activateProfileScope({ serverId, accountId: 'account-a' });
        const machine = createMachineFixture({ id: 'shared-machine', active: true, activeAt: 0 });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        storage.getState().applyMachines([machine], true, { sourceServerId: homeB.id });
        await waitForHomeGovernance(() => expect(storage.getState().endpointStatus).toBe('online'));
        const lifetimeA = captureActiveServerAccountScopeLifetime();
        expect(lifetimeA?.scope).toMatchObject({ serverId, accountId: 'account-a' });
        expect(lifetimeA?.isCurrent()).toBe(true);
        const targetId = 'browserTarget:acme.preview:home-b';
        const browserProjection = PluginProjectionV2Schema.parse({
            v: 2,
            generation: 7,
            familiesById: {
                pluginBrowser: {
                    family: 'pluginBrowser',
                    entriesById: {
                        [targetId]: {
                            id: targetId, pluginId: 'acme.preview', occurrenceId: 'home-b-occurrence',
                            contributionKind: 'browserTarget', contributionId: 'home-b',
                            target: { kind: 'externalUrl', targetId, url: 'https://home-b-preview.example.test/' },
                            display: { title: 'Home B preview' },
                            currentUrl: 'https://home-b-preview.example.test/',
                            launchMode: 'currentView', profileMode: 'session',
                        },
                    },
                },
            },
        });
        daemonDescribe.mockImplementation(async (request: Readonly<{ serverId: string }>) => request.serverId === homeB.id
            ? { protocolVersion: 1, projection: browserProjection }
            : readyResponse(7));
        const hook = await renderHook(() => ({
            focused: usePluginUiProjectionCurrentness({ machineId: machine.id, serverId }),
            background: usePluginUiProjectionCurrentness({ machineId: machine.id, serverId: homeB.id }),
            admission: { endpointStatus: useEndpointStatus(), machine: useMachineCliDetectionTarget(machine.id) },
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().focused.phase, JSON.stringify({
            endpointStatus: storage.getState().endpointStatus,
            machinePresent: Boolean(storage.getState().machines[machine.id]),
            machineOnline: Boolean(storage.getState().machines[machine.id]
                && isMachineOnline(storage.getState().machines[machine.id])),
            accountCurrent: lifetimeA?.isCurrent(),
            describeRequests: network.requests.filter((request) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
                .map((request) => ({ serverUrl: request.serverUrl, accountId: request.token ? parseToken(request.token) : null })),
        })).toBe('current'));
        await waitForHomeGovernance(() => {
            const background = hook.getCurrent().background;
            const state = storage.getState();
            const scopedMachine = resolveServerScopedMachine(state, homeB.id, machine.id);
            const cache = readCachedDaemonMergedProjectionCacheEntry({ serverId: homeB.id, machineId: machine.id });
            expect(background, JSON.stringify({
                phase: background.phase,
                endpointStatus: state.endpointStatus,
                admission: hook.getCurrent().admission,
                accountScope: background.accountLifetime?.scope,
                accountCurrent: background.accountLifetime?.isCurrent(),
                scopedMachinePresent: scopedMachine !== null,
                scopedMachineOnline: scopedMachine ? isMachineOnline(scopedMachine) : false,
                focusedMachineOnline: state.machines[machine.id] ? isMachineOnline(state.machines[machine.id]) : false,
                projectionRevision: getMachineContributionRegistryProjectionRevision({ serverId: homeB.id, machineId: machine.id }),
                cacheKind: cache?.kind,
                cacheFailureReason: cache?.kind === 'error' ? cache.reason : undefined,
                homeBCredentialRequests: network.credentialRequests.filter((request) => request.serverUrl === homeB.serverUrl),
                homeBHttpPaths: network.httpRequests.filter((request) => new URL(request.url).origin === homeB.serverUrl)
                    .map((request) => new URL(request.url).pathname),
                describeRequests: network.requests.filter((request) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
                    .map((request) => ({ serverUrl: request.serverUrl, accountId: request.token ? parseToken(request.token) : null })),
            })).toMatchObject({
                phase: 'current', interactionEnabled: true, serverId: homeB.id,
                pluginBrowserProjection: { targetsById: { [targetId]: {
                    occurrenceId: 'home-b-occurrence', currentUrl: 'https://home-b-preview.example.test/',
                } } },
            });
        });
        expect(network.requests.filter((request) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            && request.serverUrl === homeB.serverUrl).map((request) => request.token ? parseToken(request.token) : null))
            .toEqual(['account-b']);
        expect(lifetimeA?.isCurrent()).toBe(true);
        expect(hook.getCurrent().focused.phase).toBe('current');
        const lifetimeB = hook.getCurrent().background.accountLifetime;
        expect(lifetimeB?.scope).toMatchObject({ serverId: homeB.id, accountId: 'account-b' });
        expect(lifetimeB?.isCurrent()).toBe(true);
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await act(async () => { await disconnectActiveServerConnection(); });
        expect(lifetimeA?.isCurrent()).toBe(false);
        expect(lifetimeB?.isCurrent()).toBe(true);
        const retainedMachineB = resolveServerScopedMachine(storage.getState(), homeB.id, machine.id);
        expect(retainedMachineB?.id).toBe(machine.id);
        expect(retainedMachineB && isMachineOnline(retainedMachineB)).toBe(true);
        expect(hook.getCurrent().background, JSON.stringify({
            focusedEndpointStatus: storage.getState().endpointStatus,
            focusedMachinePresent: Boolean(storage.getState().machines[machine.id]),
            backgroundAccountCurrent: lifetimeB?.isCurrent(),
        })).toMatchObject({
            phase: 'current', interactionEnabled: true,
            pluginBrowserProjection: { targetsById: { [targetId]: {
                occurrenceId: 'home-b-occurrence', currentUrl: 'https://home-b-preview.example.test/',
            } } },
        });

        // A Home selection can settle its credential projection before that
        // Home becomes the applied endpoint. Disconnect then publishes the
        // selected Home without changing the already-connecting status or its
        // independent qualified Machine observation.
        const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
        const { getAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        await act(async () => { await setActiveServer({ serverId: homeB.id }); });
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().background).toMatchObject({ phase: 'current', interactionEnabled: true });
            expect(hook.getCurrent().background.accountLifetime?.isCurrent()).toBe(true);
        });
        expect(getAppliedActiveServerSnapshot().serverId).toBe(serverId);
        const settledLifetimeB = hook.getCurrent().background.accountLifetime;
        expect(settledLifetimeB?.scope).toMatchObject({ serverId: homeB.id, accountId: 'account-b' });
        const endpointBeforeHomePublication = storage.getState().endpointStatus;
        expect(endpointBeforeHomePublication).toBe('connecting');
        await act(async () => { await disconnectActiveServerConnection(); });
        expect(getAppliedActiveServerSnapshot().serverId).toBe(homeB.id);
        expect(storage.getState().endpointStatus).toBe(endpointBeforeHomePublication);
        expect(settledLifetimeB?.isCurrent()).toBe(true);
        const focusedMachineB = resolveServerScopedMachine(storage.getState(), homeB.id, machine.id);
        expect(focusedMachineB && isMachineOnline(focusedMachineB)).toBe(true);
        expect(hook.getCurrent().background).toMatchObject({
            phase: 'retainedOffline', interactionEnabled: false, pluginBrowserProjection: null,
        });
    });

    it('admits a nonfocused Home Browser projection from a machine absent from the focused Home inventory', async () => {
        const homeB = await network.addHome('https://projection-browser-machine-b.example.test', 'account-b');
        homeIds.set(homeB.serverUrl, homeB.id);
        await writeRealHomeCredentials(homeB);
        const { storage, useEndpointStatus } = await import('@/sync/domains/state/storage');
        const { prepareWarmCacheEncryptionKey } = await import('@/sync/domains/state/warmCacheEncryptionKey');
        const { usePluginUiProjectionCurrentness } = await import('@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness');
        const { parseToken } = await import('@/utils/auth/parseToken');
        const { isMachineOnline } = await import('@/utils/sessions/machineUtils');
        const { resolveServerScopedMachine } = await import('@/sync/domains/machines/resolveServerScopedMachine');
        await prepareWarmCacheEncryptionKey();
        storage.getState().activateProfileScope({ serverId, accountId: 'account-a' });
        const machineA = createMachineFixture({ id: 'focused-machine-a', active: true, activeAt: 0 });
        const machineB = createMachineFixture({ id: 'background-only-machine-b', active: true, activeAt: 0 });
        storage.getState().applyMachines([machineA], true, { sourceServerId: serverId });
        storage.getState().applyMachines([machineB], true, { sourceServerId: homeB.id });
        expect(storage.getState().machines[machineB.id]).toBeUndefined();
        await waitForHomeGovernance(() => expect(storage.getState().endpointStatus).toBe('online'));
        const targetId = 'browserTarget:acme.preview:background-machine';
        const browserProjection = PluginProjectionV2Schema.parse({
            v: 2, generation: 8,
            familiesById: { pluginBrowser: { family: 'pluginBrowser', entriesById: {
                [targetId]: {
                    id: targetId, pluginId: 'acme.preview', occurrenceId: 'background-machine-occurrence',
                    contributionKind: 'browserTarget', contributionId: 'background-machine',
                    target: { kind: 'externalUrl', targetId, url: 'https://background-machine.example.test/' },
                    display: { title: 'Background machine preview' },
                    currentUrl: 'https://background-machine.example.test/',
                    launchMode: 'currentView', profileMode: 'session',
                },
            } } },
        });
        daemonDescribe.mockImplementation(async (request: Readonly<{ serverId: string }>) => request.serverId === homeB.id
            ? { protocolVersion: 1, projection: browserProjection }
            : readyResponse(8));
        const hook = await renderHook(() => ({
            focused: usePluginUiProjectionCurrentness({ machineId: machineA.id, serverId }),
            background: usePluginUiProjectionCurrentness({ machineId: machineB.id, serverId: homeB.id }),
            backgroundAdmissionGate: {
                endpointStatus: useEndpointStatus(),
            },
        }));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().focused.phase).toBe('current'));
            await waitForHomeGovernance(() => expect(hook.getCurrent().background.accountLifetime?.scope)
                .toMatchObject({ serverId: homeB.id, accountId: 'account-b' }));
            expect(hook.getCurrent().background.accountLifetime?.isCurrent()).toBe(true);
            const qualifiedMachineB = resolveServerScopedMachine(storage.getState(), homeB.id, machineB.id);
            expect(qualifiedMachineB?.id).toBe(machineB.id);
            expect(qualifiedMachineB && isMachineOnline(qualifiedMachineB)).toBe(true);
            await waitForHomeGovernance(() => expect({
                ...hook.getCurrent().background,
                publicAdmissionGate: hook.getCurrent().backgroundAdmissionGate,
                describeRequests: network.requests
                    .filter((request) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
                    .map((request) => ({ serverUrl: request.serverUrl, machineId: request.targetId })),
            }).toMatchObject({
                phase: 'current', interactionEnabled: true, machineId: machineB.id, serverId: homeB.id,
                pluginBrowserProjection: { targetsById: { [targetId]: {
                    currentUrl: 'https://background-machine.example.test/',
                } } },
            }));
            expect(network.requests.filter((request) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
                && request.serverUrl === homeB.serverUrl).map((request) => ({
                machineId: request.targetId, accountId: request.token ? parseToken(request.token) : null,
            }))).toEqual([{ machineId: machineB.id, accountId: 'account-b' }]);
            expect(hook.getCurrent().focused.phase).toBe('current');
        } finally {
            await hook.unmount();
        }
    });

    it('presents an operation-bearing Browser action for its borrowed nonfocused Home Account', async () => {
        const homeB = await network.addHome('https://projection-browser-operation-b.example.test', 'account-b');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { executePluginBrowserAction, normalizePluginBrowserProjection } = await import('@/sync/domains/plugins/browser/actions');
        const { createPluginUiProjectedActionResolver, normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
        const { DaemonPluginStructuredMessageActionExecuteRequestSchema } = await import('@happier-dev/protocol/plugins/actions/daemonInvocationV1');
        const { ActionOperationSnapshotV1Schema } = await import('@happier-dev/protocol/actions/operations/v1');
        const { qualifyActionOperationSnapshot } = await import('@/sync/domains/actionOperations/qualifiedActionOperation');
        const { actionOperationPresentationCoordinator } = await import('@/components/inbox/actionOperations/actionOperationPresentationRuntime');
        const { Modal } = await import('@/modal');
        const { randomUUID } = await import('@/platform/randomUUID');
        const { parseToken } = await import('@/utils/auth/parseToken');
        const { storage } = await import('@/sync/domains/state/storage');
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockRestore();
        expect(await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, {
            token: createAccountTokenForTests('account-b'),
        })).toBe(true);
        storage.getState().activateProfileScope({ serverId, accountId: 'account-a' });
        expect(captureActiveServerAccountScopeLifetime()?.scope).toMatchObject({ serverId, accountId: 'account-a' });
        const hook = await renderHook(() => useServerCredentialAccountScopeBinding(homeB.id));
        const presented: unknown[] = [];
        // Modal's provider is the native/web presentation boundary. The real
        // launch coordinator and operation observation remain unmocked.
        const unregisterModal = Modal.registerProvider({
            showModal: (config) => { presented.push(config); return randomUUID(); },
            hideModal: () => {}, hideAllModals: () => {}, updateCustomModalProps: () => {},
        });
        actionOperationPresentationCoordinator.reset();
        try {
            await vi.waitFor(() => expect(hook.getCurrent().binding?.scope.accountId).toBe('account-b'));
            const lifetimeB = hook.getCurrent().binding;
            if (!lifetimeB) throw new Error('Home B credential lifetime was not admitted');
            const raw = browserActionProjection({
                version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' },
            });
            const uiProjection = normalizePluginUiProjection(raw);
            const action = normalizePluginBrowserProjection(raw).actionsById['browserAction:acme.preview:open-preview'];
            const operationObserved = createDeferred<ReturnType<typeof ActionOperationSnapshotV1Schema.parse>>();
            network.setRpcAckResponder(async (request) => {
                if (request.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                    return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
                }
                const payload = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.payload);
                const accountId = request.token ? parseToken(request.token) : null;
                if (!accountId || !payload.requestId) throw new Error('Operation issuance lacked Account/request authority');
                // The external daemon boundary allocates its operation identity
                // and echoes the request id actually generated by the real launch.
                operationObserved.resolve(ActionOperationSnapshotV1Schema.parse({
                    version: 1, operationId: randomUUID(), revision: 1,
                    actionId: payload.qualifiedActionId, requestId: payload.requestId,
                    state: 'running', scope: { accountId, machineId: request.targetId, sessionId: payload.sessionId },
                    title: 'Open preview', createdAt: 1, startedAt: 2, cancellation: 'unsupported',
                }));
                return { ok: true, result: { ok: true, result: { preview: 'opened' } } };
            });
            expect(await executePluginBrowserAction({
                action, machineId: 'shared-machine', serverId: homeB.id, accountLifetime: lifetimeB,
                sessionId: 'browser-session', input: {}, pluginUiProjection: uiProjection,
                resolveContributedAction: createPluginUiProjectedActionResolver(uiProjection.actionsById),
            })).toEqual({ ok: true, result: { preview: 'opened' } });
            const observed = await operationObserved.promise;
            expect(observed).toMatchObject({ scope: { accountId: 'account-b' } });
            actionOperationPresentationCoordinator.observe(qualifyActionOperationSnapshot(homeB.id, observed));
            expect(presented).toMatchObject([{ type: 'custom', props: { serverId: homeB.id, operationId: observed.operationId } }]);
            expect(captureActiveServerAccountScopeLifetime()?.scope).toMatchObject({ serverId, accountId: 'account-a' });
        } finally {
            actionOperationPresentationCoordinator.reset();
            unregisterModal();
            await hook.unmount();
            await TokenStorage.removeCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id });
        }
    });

    it('does not issue a Home Browser action after its real credential lifetime retires and preserves an already-issued acknowledgement', async () => {
        const homeB = await network.addHome('https://projection-browser-action-home-b.example.test', 'account-b');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { executePluginBrowserAction, normalizePluginBrowserProjection } = await import('@/sync/domains/plugins/browser/actions');
        const { createPluginUiProjectedActionResolver, normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
        const { parseToken } = await import('@/utils/auth/parseToken');
        const { storage } = await import('@/sync/domains/state/storage');
        // This case needs the real parser, device custody and mutation fanout, not the
        // network harness's shortcut credential getter. Storage uses the canonical OS boundary.
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockRestore();
        const credentialsB = { token: createAccountTokenForTests('account-b') };
        const credentialsC = { token: createAccountTokenForTests('account-c') };
        expect(await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, credentialsB)).toBe(true);
        storage.getState().activateProfileScope({ serverId, accountId: 'account-a' });
        const lifetimeA = captureActiveServerAccountScopeLifetime();
        expect(lifetimeA?.scope).toMatchObject({ serverId, accountId: 'account-a' });
        expect(lifetimeA?.isCurrent()).toBe(true);
        const hook = await renderHook(() => useServerCredentialAccountScopeBinding(homeB.id));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().binding?.scope.accountId).toBe('account-b'));
            const initialLifetimeB = hook.getCurrent().binding;
            if (!initialLifetimeB) throw new Error('Home B credential lifetime was not admitted');
            let lifetimeB = initialLifetimeB;
            const actionId = 'browserAction:acme.preview:open-preview';
            const raw = browserActionProjection();
            const uiProjection = normalizePluginUiProjection(raw);
            const browserAction = normalizePluginBrowserProjection(raw).actionsById[actionId];
            expect(browserAction).toBeDefined();
            const execute = () => executePluginBrowserAction({
                action: browserAction, machineId: 'shared-machine', serverId: homeB.id,
                sessionId: 'browser-session', input: {}, pluginUiProjection: uiProjection,
                accountLifetime: lifetimeB,
                resolveContributedAction: createPluginUiProjectedActionResolver(uiProjection.actionsById),
                isCurrent: lifetimeB.isCurrent,
            });
            network.setRpcAckResponder(async (request) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE
                ? { ok: true, result: { ok: true, result: { preview: 'opened' } } }
                : { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
            // Establish actual dispatch before probing retirement, so an unrelated transport
            // refusal cannot make an empty issuance record look like correct fencing.
            expect(await execute()).toEqual({ ok: true, result: { preview: 'opened' } });
            expect(network.requests.filter((request) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)
                .map((request) => request.token ? parseToken(request.token) : null)).toEqual(['account-b']);
            const knownIssued = createDeferred<string | null>();
            const knownAcknowledgement = createDeferred<void>();
            network.setRpcAckResponder(async (request) => {
                if (request.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                    return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
                }
                knownIssued.resolve(request.token ? parseToken(request.token) : null);
                await knownAcknowledgement.promise;
                return { ok: true, result: { ok: true, result: { preview: 'opened' } } };
            });
            const knownPending = execute();
            try {
                expect(await knownIssued.promise).toBe('account-b');
                await act(async () => {
                    expect(await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, credentialsC)).toBe(true);
                });
                expect(lifetimeB.isCurrent()).toBe(false);
            } finally {
                knownAcknowledgement.resolve(undefined);
            }
            expect(await knownPending).toEqual({ ok: true, result: { preview: 'opened' } });
            await vi.waitFor(() => expect(hook.getCurrent().binding?.scope.accountId).toBe('account-c'));
            // The next invocation is an independent action from a newly admitted
            // B source, not a retry of the physical effect whose ACK was consumed.
            await act(async () => {
                expect(await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, credentialsB)).toBe(true);
            });
            await vi.waitFor(() => expect(hook.getCurrent().binding?.scope.accountId).toBe('account-b'));
            const successorLifetimeB = hook.getCurrent().binding;
            if (!successorLifetimeB) throw new Error('Successor Home B credential lifetime was not admitted');
            lifetimeB = successorLifetimeB;
            const mutationCompleted = createDeferred<void>();
            const issued: Array<Readonly<{ accountId: string | null; sourceCurrent: boolean }>> = [];
            network.setRpcAckResponder(async (request) => {
                if (request.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                    return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
                }
                issued.push({ accountId: request.token ? parseToken(request.token) : null, sourceCurrent: lifetimeB.isCurrent() });
                // An already-issued known ACK stays authoritative even if credentials retire
                // while that external reply is in flight. No server effect is cancelled here.
                await mutationCompleted.promise;
                return { ok: true, result: { ok: true, result: { preview: 'opened' } } };
            });
            let outcome: Awaited<ReturnType<typeof executePluginBrowserAction>> | undefined;
            await act(async () => {
                const pending = execute();
                try {
                    expect(await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, credentialsC)).toBe(true);
                } finally {
                    mutationCompleted.resolve(undefined);
                }
                outcome = await pending;
            });
            expect(lifetimeB.isCurrent()).toBe(false);
            await vi.waitFor(() => expect(hook.getCurrent().binding?.scope.accountId).toBe('account-c'));
            expect(issued.filter((request) => !request.sourceCurrent)).toEqual([]);
            if (issued.length > 0) {
                expect(issued).toEqual([{ accountId: 'account-b', sourceCurrent: true }]);
                expect(outcome).toEqual({ ok: true, result: { preview: 'opened' } });
            } else {
                expect(outcome).toMatchObject({ ok: false });
            }
            expect(lifetimeA?.isCurrent()).toBe(true);
        } finally {
            await hook.unmount();
            await TokenStorage.removeCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id });
        }
    });

    it('reloads the authoritative projection when plugin mutation invalidates the active machine scope', async () => {
        const hook = await settledHook();
        expect(hook.getCurrent().inputs?.pluginProjectionV2?.generation).toBe(1);
        const reload = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementationOnce(() => reload.promise);
        await act(async () => publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId }, 'authority'));
        expect(hook.getCurrent()).toMatchObject({ phase: 'loading', inputs: { pluginProjectionV2: { generation: 1 } } });
        reload.resolve(readyResponse(2));
        await vi.waitFor(() => expect(hook.getCurrent().inputs?.pluginProjectionV2?.generation).toBe(2));
        expect(daemonDescribe).toHaveBeenCalledTimes(2);
    });
    it('retains the last ready projection as stale metadata when an invalidation refresh fails', async () => {
        const hook = await settledHook();
        daemonDescribe.mockRejectedValueOnce(new RpcError('Private transport details', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE));
        await act(async () => publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId }, 'authority'));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'error', failureReason: 'transport-unavailable', inputs: { pluginProjectionV2: { generation: 1 } } }));
    });
    it.each(['revision', 'identity', 'reconnect', 'transport-revision', 'transport-demand'] as const)('reacquires one invalid answer on %s push and none on unrelated arrivals', async signal => {
        const { publishMachineContributionRegistryProjectionRefresh, getMachineContributionRegistryProjectionRevision } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
        const { createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        // Pushed rows preserve the Plain mode admitted by fetchAndApplyMachines.
        const machine = createMachineFixture({ id: 'machine-1', storageMode: 'plain', daemonStateVersion: 1,
            daemonState: { contributionRegistryProjectionRevision: 1, runtimeId: 'daemon-a' } });
        // Exact admission and the list must report the same daemon facts as
        // the pushed row; the harness default is a legacy row without them.
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a', machine })]);
            return createPlainMachineReadHttpResponseFixture(path, init, 'account-a', machine);
        });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        // Corrupt only the external reply. The transport parser, shared loader,
        // real Machine writer and mounted readers retain their production logic.
        const transportFailure = signal.startsWith('transport-');
        if (transportFailure) daemonDescribe.mockRejectedValueOnce(new Error('External transport failed'));
        else daemonDescribe.mockResolvedValueOnce({ ...readyResponse(1), projection: { v: 3, generation: 1 } });
        const hook = await renderHook(() => [
            useDaemonMergedProjectionInputs({ sections: 'complete', machineId: machine.id, serverId }),
            useDaemonMergedProjectionInputs({ sections: 'complete', machineId: machine.id, serverId }),
        ]);
        try {
            const reason = transportFailure ? 'transport-error' : 'invalid-response';
            await vi.waitFor(() => expect(hook.getCurrent().map(state => state.failureReason)).toEqual([reason, reason]));
            expect(daemonDescribe).toHaveBeenCalledTimes(1);
            const settledRevision = getMachineContributionRegistryProjectionRevision({ machineId: machine.id, serverId });
            await act(async () => {
                for (let index = 0; index < 100; index++) {
                    storage.getState().applyMachines([{ ...machine, id: 'unrelated-machine', daemonStateVersion: index + 2,
                        daemonState: { ...machine.daemonState, resources: { revision: index } } }], false, { sourceServerId: serverId });
                }
                publishMachineContributionRegistryProjectionInvalidation({ machineId: 'unrelated-machine', serverId }, 'authority');
                publishMachineContributionRegistryProjectionRefresh(otherServerId);
            });
            await flushHookEffects();
            expect({ revision: getMachineContributionRegistryProjectionRevision({ machineId: machine.id, serverId }), reads: daemonDescribe.mock.calls.length })
                .toEqual({ revision: settledRevision, reads: 1 });
            if (signal === 'transport-demand') {
                const renewed = await renderHook(() => useDaemonMergedProjectionInputs({ sections: 'complete', machineId: machine.id, serverId }));
                try {
                    await vi.waitFor(() => expect(renewed.getCurrent().phase).toBe('ready'));
                    expect(hook.getCurrent().map(state => state.phase)).toEqual(['ready', 'ready']);
                    expect(daemonDescribe).toHaveBeenCalledTimes(2);
                    await renewed.rerender();
                    await flushHookEffects();
                    expect(daemonDescribe).toHaveBeenCalledTimes(2);
                } finally { await renewed.unmount(); }
                return;
            }
            await act(async () => {
                if (signal === 'reconnect') publishMachineContributionRegistryProjectionRefresh(serverId);
                else storage.getState().applyMachines([{ ...machine, daemonStateVersion: 102,
                    daemonState: { ...machine.daemonState,
                        ...(signal === 'identity' ? { runtimeId: 'daemon-b' } : { contributionRegistryProjectionRevision: 2 }) } }], false, { sourceServerId: serverId });
            });
            await vi.waitFor(() => expect(hook.getCurrent().map(state => state.phase),
                JSON.stringify(hook.getCurrent().map(state => state.failureReason))).toEqual(['ready', 'ready']));
            expect(daemonDescribe).toHaveBeenCalledTimes(2);
        } finally { await hook.unmount(); }
    });
    it('exposes a cold transport failure and recovers through the explicit Retry refresh key', async () => {
        daemonDescribe.mockRejectedValueOnce(new RpcError('Private transport details', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE));
        const hook = await renderHook(({ refreshKey }: { refreshKey: number }) => (
            useDaemonMergedProjectionInputs({ sections: 'complete', machineId: 'machine-1', serverId, refreshKey })
        ), { initialProps: { refreshKey: 0 } });
        await vi.waitFor(() => expect(hook.getCurrent()).toEqual({
            phase: 'error', inputs: null, failureReason: 'transport-unavailable',
        }));

        await hook.rerender({ refreshKey: 1 });
        await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
        expect(hook.getCurrent().failureReason).toBeUndefined();
        expect(hook.getCurrent().inputs?.pluginProjectionV2?.generation).toBe(1);
        expect(daemonDescribe).toHaveBeenCalledTimes(2);
    });
    it('does not re-read a current projection when a Session reader mounts after it has aged, and re-reads it once after invalidation', async () => {
        // Session open mounts the composer/transcript readers. Currentness is
        // the Machine projection revision, never elapsed time (P03-SESSION-SETTLE).
        await primeCache(3);
        const realNow = Date.now;
        const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 10 * 60_000);
        try {
            const hook = await renderHook(() => useDaemonMergedProjectionInputs({ machineId: 'machine-1', serverId,
                sections: ['actionsById', 'familiesById.pluginUi', 'resourcesById'] }));
            await flushHookEffects({ cycles: 3, turns: 2 });
            expect(daemonDescribe).toHaveBeenCalledTimes(0);
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 3 } } }));
            daemonDescribe.mockResolvedValueOnce(readyResponse(4));
            await act(async () => publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId }, 'authority'));
            await vi.waitFor(() => expect(hook.getCurrent().inputs?.pluginProjectionV2?.generation).toBe(4));
            expect(daemonDescribe).toHaveBeenCalledTimes(1);
            await hook.unmount();
        } finally { now.mockRestore(); }
    });
    it('serves only the cached projection and never asks the machine when loading is off', async () => {
        await primeCache(4);
        const hook = await renderHook(() => useDaemonMergedProjectionInputs({ sections: 'complete', machineId: 'machine-1', serverId, load: false }));
        await flushHookEffects({ cycles: 3, turns: 2 });
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 4 } } }));
        expect(daemonDescribe).not.toHaveBeenCalled();
    });
    it('updates an already mounted cache reader when another consumer publishes the ready projection', async () => {
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const committed: Array<Readonly<{ state: ReturnType<typeof useDaemonMergedProjectionInputs>; lifetime: object | null }>> = [];
        const identities = new WeakMap<object, number>();
        let nextIdentity = 1;
        const identity = (value: object | null): number | null => {
            if (!value) return null;
            const held = identities.get(value);
            if (held !== undefined) return held;
            const assigned = nextIdentity++;
            identities.set(value, assigned);
            return assigned;
        };
        const hook = await renderHook(() => {
            const account = useServerCredentialAccountScopeBinding(serverId);
            const state = useDaemonMergedProjectionInputs({ sections: 'complete', machineId: 'machine-1', serverId, load: false,
                accountLifetime: account.binding });
            React.useLayoutEffect(() => { committed.push({ state, lifetime: account.binding }); });
            return state;
        });
        await flushHookEffects({ cycles: 3, turns: 2 });
        expect(daemonDescribe).not.toHaveBeenCalled();
        expect(hook.getCurrent().inputs).toBeNull();
        const sequence = committed.map(({ state, lifetime }) => ({
            phase: state.phase, state: identity(state), inputs: identity(state.inputs), lifetime: identity(lifetime),
            generation: state.inputs?.pluginProjectionV2?.generation ?? null, failureReason: state.failureReason ?? null,
        }));
        // A real Account transition may fence stale content with a new loading
        // value. Only compare equal public states under the identical lifetime.
        const equalStateReallocations = committed.flatMap(({ state, lifetime }, index) => {
            const previous = committed[index - 1];
            return previous && previous.lifetime === lifetime && previous.state !== state
                && previous.state.phase === state.phase && previous.state.inputs === state.inputs
                && previous.state.failureReason === state.failureReason ? [index] : [];
        });
        expect.soft(equalStateReallocations, JSON.stringify({ sequence })).toEqual([]);
        await act(async () => {
            await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'machine-1', serverId,
                accountLifetime: captureActiveServerAccountScopeLifetime() });
        });
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({
            phase: 'ready', inputs: { pluginProjectionV2: { generation: 1 } },
        }));
        expect(daemonDescribe).toHaveBeenCalledTimes(1);
        const active = await settledHook();
        daemonDescribe.mockResolvedValueOnce(readyResponse(2));
        await act(async () => {
            await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'machine-1', serverId,
                accountLifetime: captureActiveServerAccountScopeLifetime() });
        });
        await vi.waitFor(() => {
            expect(hook.getCurrent().inputs?.pluginProjectionV2?.generation).toBe(2);
            expect(active.getCurrent().inputs?.pluginProjectionV2?.generation).toBe(2);
        });
        expect(daemonDescribe).toHaveBeenCalledTimes(2);
    });
    it('withdraws a mounted cache reader after a failed shared read and recovers on renewed demand', async () => {
        await primeCache(1);
        const hook = await renderHook(({ load }: { load: boolean }) => useDaemonMergedProjectionInputs({ sections: 'complete',
            machineId: 'machine-1', serverId, load,
        }), { initialProps: { load: false } });
        expect(hook.getCurrent().phase).toBe('ready');

        daemonDescribe.mockRejectedValueOnce(new RpcError('Private transport details', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE));
        await act(async () => {
            await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'machine-1', serverId,
                accountLifetime: captureActiveServerAccountScopeLifetime() });
        });
        expect(hook.getCurrent()).toMatchObject({
            phase: 'error', failureReason: 'transport-unavailable',
            inputs: { pluginProjectionV2: { generation: 1 } },
        });

        const answer = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementationOnce(() => answer.promise);
        await hook.rerender({ load: true });
        expect(hook.getCurrent().phase).toBe('loading');
        await act(async () => { answer.resolve(readyResponse(2)); });
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({
            phase: 'ready', inputs: { pluginProjectionV2: { generation: 2 } },
        }));
        expect(hook.getCurrent().failureReason).toBeUndefined();
        expect(daemonDescribe).toHaveBeenCalledTimes(2);
    });
    it('restores inert stale metadata from an error cache entry after remount', async () => {
        await primeCache(1, true);
        daemonDescribe.mockRejectedValueOnce(new Error('Transport still unavailable'));
        const hook = await renderHook(() => useDaemonMergedProjectionInputs({ sections: 'complete', machineId: 'machine-1', serverId }));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'error', inputs: { pluginProjectionV2: { generation: 1 } } }));
    });
    it('revalidates instead of serving a fresh cached failure as authoritative', async () => {
        await primeCache(1, true);
        const phases: string[] = [];
        const hook = await renderHook(() => {
            const state = useDaemonMergedProjectionInputs({ sections: 'complete', machineId: 'machine-1', serverId });
            phases.push(state.phase);
            return state;
        });
        expect(phases[0]).toBe('loading');
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 1 } } }));
        expect(daemonDescribe).toHaveBeenCalledTimes(1);
    });
    it('does not publish a fresh cached ready entry from the previous revision on first mount', async () => {
        await primeCache(1);
        publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId }, 'authority');
        const pending = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementationOnce(() => pending.promise);
        const hook = await renderHook(() => useDaemonMergedProjectionInputs({ sections: 'complete', machineId: 'machine-1', serverId }));
        expect(hook.getCurrent().phase).toBe('loading');
        await vi.waitFor(() => expect(daemonDescribe).toHaveBeenCalledTimes(1));
        pending.resolve(readyResponse(2));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 2 } } }));
    });
    it('does not expose the previous machine projection while a newly selected machine loads', async () => {
        const pending = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementation((request: Readonly<{ machineId: string }>) => request.machineId === 'machine-2' ? pending.promise : readyResponse(1));
        const hook = await renderHook((machineId: string) => useDaemonMergedProjectionInputs({ sections: 'complete', machineId, serverId }), { initialProps: 'machine-1' });
        await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
        await hook.rerender('machine-2');
        expect(hook.getCurrent()).toEqual({ phase: 'loading', inputs: null });
        pending.resolve(readyResponse(2));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 2 } } }));
    });
    it('does not expose a projection from another server when the machine id is unchanged', async () => {
        const pending = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementation((request: Readonly<{ serverId: string }>) => request.serverId === otherServerId ? pending.promise : readyResponse(1));
        const hook = await renderHook((selectedServerId: string) => useDaemonMergedProjectionInputs({ sections: 'complete', machineId: 'machine-1', serverId: selectedServerId }), { initialProps: serverId });
        await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
        await hook.rerender(otherServerId);
        expect(hook.getCurrent()).toEqual({ phase: 'loading', inputs: null });
        pending.resolve(readyResponse(2));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 2 } } }));
    });
    it.each(['routed credential', 'active runtime'] as const)('reacquires exactly once when a cold deferred Describe loses its %s binding', async owner => {
        const { buildDeferredDaemonProjectionSections, DaemonContributionRegistryProjectionDescribeResponseSchema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const { readCachedDaemonMergedProjectionCacheEntry, subscribeDaemonMergedProjectionSummary } = await import('./loadDaemonMergedProjectionInputs');
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockRestore();
        const credentials = { token: createAccountTokenForTests('account-a') };
        const homeUrl = 'https://projection-hook.example.test';
        expect(await TokenStorage.setCredentialsForServerUrl(homeUrl, { serverId }, credentials)).toBe(true);
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(readyResponse(7));
        const deferred = buildDeferredDaemonProjectionSections({ ...response, projectionDigest: 'a'.repeat(64) });
        const firstSection = createDeferred<void>();
        let manifests = 0;
        let sections = 0;
        daemonDescribe.mockImplementation(async ({ payload }) => {
            if (!payload.sectionRead) {
                manifests++;
                return deferred.manifest;
            }
            if (++sections === 1) await firstSection.promise;
            return deferred.read(payload.sectionRead.digest, payload.sectionRead.offset,
                payload.sectionRead.includeDigests);
        });
        const published: number[] = [];
        const unsubscribe = subscribeDaemonMergedProjectionSummary({ serverId, machineId: 'machine-1' }, () => {
            const entry = readCachedDaemonMergedProjectionCacheEntry({ serverId, machineId: 'machine-1' });
            if (entry?.kind === 'ready') published.push(entry.inputs.pluginProjectionV2!.generation);
        });
        const hook = await renderHook(() => {
            const account = useServerCredentialAccountScopeBinding(serverId);
            const projection = useDaemonMergedProjectionInputs({ sections: 'complete', machineId: 'machine-1',
                ...(owner === 'routed credential' ? { serverId, accountLifetime: account.binding } : {}) });
            return { account, projection };
        });
        try {
            await vi.waitFor(() => expect(sections).toBe(1));
            const previous = owner === 'routed credential' ? hook.getCurrent().account.binding! : captureActiveServerAccountScopeLifetime()!;
            expect(previous.isCurrent()).toBe(true);
            expect(manifests).toBe(1);
            expect(published).toEqual([]);
            await act(async () => {
                if (owner === 'routed credential') {
                    expect(await TokenStorage.setCredentialsForServerUrl(homeUrl, { serverId }, credentials)).toBe(true);
                } else {
                    // The real connection owner withdraws then reapplies even the
                    // same Home/Account during restore; demand stays mounted.
                    publishAppliedActiveServerRuntimeAvailability(false);
                    publishAppliedActiveServerRuntimeAvailability(true);
                }
            });
            expect(previous.isCurrent()).toBe(false);
            await vi.waitFor(() => expect(hook.getCurrent().projection).toMatchObject({
                phase: 'ready', inputs: { pluginProjectionV2: { generation: 7 } },
            }));
            expect(hook.getCurrent().account.binding?.isCurrent()).toBe(true);
            expect(manifests).toBe(2);
            expect(published).toEqual([7]);
            const settledReads = daemonDescribe.mock.calls.length;
            await hook.rerender();
            await hook.rerender();
            expect(daemonDescribe).toHaveBeenCalledTimes(settledReads);
            await act(async () => {
                storage.getState().applyMachines([createMachineFixture({
                    id: 'unrelated-machine', daemonStateVersion: 2,
                    daemonState: { contributionRegistryProjectionRevision: 2, runtimeId: 'unrelated-daemon' },
                })], false, { sourceServerId: serverId });
            });
            await flushHookEffects();
            expect(daemonDescribe.mock.calls.length - settledReads).toBe(0);
            expect(manifests).toBe(2);
            expect(published).toEqual([7]);
            expect(hook.getCurrent().projection.phase).toBe('ready');
        } finally {
            firstSection.resolve();
            await hook.unmount();
            unsubscribe();
        }
    });

    it('withdraws retained metadata on a real credential replacement within the same Home', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { parseToken } = await import('@/utils/auth/parseToken');
        // Keep real device custody, token parsing and credential-mutation fanout.
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockRestore();
        const homeUrl = 'https://projection-hook.example.test';
        expect(await TokenStorage.setCredentialsForServerUrl(homeUrl, { serverId }, {
            token: createAccountTokenForTests('account-a'),
        })).toBe(true);
        const replacement = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockResolvedValueOnce(readyResponse(1));
        daemonDescribe.mockImplementation(() => replacement.promise);
        const observedRenders: Array<Readonly<{
            serverId: string | null;
            accountId: string | null;
            projectionGeneration: number | null;
        }>> = [];
        const hook = await renderHook(() => {
            const projection = useDaemonMergedProjectionInputs({ sections: 'complete',
                machineId: 'machine-1', serverId, retainInputsAcrossScopeChange: true,
            });
            const account = useServerCredentialAccountScopeBinding(serverId);
            observedRenders.push({
                serverId: account.binding?.scope.serverId ?? null,
                accountId: account.binding?.scope.accountId ?? null,
                projectionGeneration: projection.inputs?.pluginProjectionV2?.generation ?? null,
            });
            return { projection, account };
        });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().projection).toMatchObject({
                phase: 'ready', inputs: { pluginProjectionV2: { generation: 1 } },
            }));
            const lifetimeA = hook.getCurrent().account.binding;
            expect(lifetimeA?.scope).toMatchObject({ serverId, accountId: 'account-a' });
            expect(lifetimeA?.isCurrent()).toBe(true);
            expect(network.requests.filter((request) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
                .map((request) => request.token ? parseToken(request.token) : null)).toEqual(['account-a']);
            await act(async () => {
                expect(await TokenStorage.setCredentialsForServerUrl(homeUrl, { serverId }, {
                    token: createAccountTokenForTests('account-b'),
                })).toBe(true);
            });
            expect(lifetimeA?.isCurrent()).toBe(false);
            await vi.waitFor(() => expect(hook.getCurrent().account.binding?.scope)
                .toMatchObject({ serverId, accountId: 'account-b' }));
            expect(observedRenders.filter((rendered) => rendered.serverId === serverId
                && rendered.accountId === 'account-b' && rendered.projectionGeneration === 1)).toEqual([]);
            expect(hook.getCurrent().projection.phase).not.toBe('ready');
            expect(hook.getCurrent().projection.inputs).toBeNull();
        } finally {
            replacement.resolve(readyResponse(2));
            await hook.unmount();
        }
    });

    it('retains inert metadata through a superseded Home route while ignoring its late projection', async () => {
        const homeC = await network.addHome('https://projection-hook-third.example.test', 'account-a');
        homeIds.set(homeC.serverUrl, homeC.id);
        const pendingB = createDeferred<ReturnType<typeof readyResponse>>();
        const pendingC = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementation((request: Readonly<{ serverId: string }>) => (
            request.serverId === otherServerId ? pendingB.promise
                : request.serverId === homeC.id ? pendingC.promise
                    : readyResponse(1)
        ));
        const hook = await renderHook(
            (scope: Readonly<{ machineId: string; serverId: string }>) => useDaemonMergedProjectionInputs({ sections: 'complete',
                ...scope, retainInputsAcrossScopeChange: true,
            }),
            { initialProps: { machineId: 'machine-1', serverId } },
        );
        try {
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({
                phase: 'ready', inputs: { pluginProjectionV2: { generation: 1 } },
            }));
            await hook.rerender({ machineId: 'machine-2', serverId: otherServerId });
            await vi.waitFor(() => expect(network.requests.some((request) => (
                request.serverUrl === 'https://projection-hook-other.example.test'
                && request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ))).toBe(true));
            expect(hook.getCurrent()).toMatchObject({
                phase: 'loading', inputs: { pluginProjectionV2: { generation: 1 } },
            });
            await hook.rerender({ machineId: 'machine-3', serverId: homeC.id });
            await vi.waitFor(() => expect(network.requests.some((request) => (
                request.serverUrl === homeC.serverUrl
                && request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ))).toBe(true));
            await act(async () => { pendingB.resolve(readyResponse(2)); });
            await flushHookEffects();
            expect(hook.getCurrent()).toMatchObject({
                phase: 'loading', inputs: { pluginProjectionV2: { generation: 1 } },
            });
            pendingC.resolve(readyResponse(3));
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({
                phase: 'ready', inputs: { pluginProjectionV2: { generation: 3 } },
            }));
        } finally {
            pendingB.resolve(readyResponse(2));
            pendingC.resolve(readyResponse(3));
            await hook.unmount();
        }
    });

    it('can retain inert projection metadata across a route-driven authority change', async () => {
        const pending = createDeferred<ReturnType<typeof readyResponse>>();
        daemonDescribe.mockImplementation((request: Readonly<{ machineId: string }>) => request.machineId === 'machine-2' ? pending.promise : readyResponse(1));
        const hook = await renderHook(
            (scope: Readonly<{ machineId: string; serverId: string }>) => useDaemonMergedProjectionInputs({ sections: 'complete', ...scope, retainInputsAcrossScopeChange: true }),
            { initialProps: { machineId: 'machine-1', serverId } },
        );
        await vi.waitFor(() => expect(hook.getCurrent().phase).toBe('ready'));
        await hook.rerender({ machineId: 'machine-2', serverId: otherServerId });
        expect(hook.getCurrent()).toMatchObject({ phase: 'loading', inputs: { pluginProjectionV2: { generation: 1 } } });
        pending.resolve(readyResponse(2));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ phase: 'ready', inputs: { pluginProjectionV2: { generation: 2 } } }));
    });
});

// Summary reads need a real routed Account, not a focused Sync bootstrap whose
// independent Machine census would contaminate the descriptive-key budget.
it('does not resolve the descriptive Home key again on unchanged summary renders', async () => {
    network.resetRequests();
    storage.setState(storage.getInitialState(), true);
    clearDaemonMergedProjectionCacheForTests();
    const home = await network.addHome('https://projection-summary-unfocused.example.test', 'account-a');
    network.setRpcAckResponder(async (request) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
        ? { ok: true, result: readyResponse(7) }
        : { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const credential = await renderHook(() => useServerCredentialAccountScopeBinding(home.id));
    try {
        await vi.waitFor(() => expect(credential.getCurrent().binding).not.toBeNull());
        const accountLifetime = credential.getCurrent().binding;
        if (!accountLifetime) throw new Error('The routed summary fixture did not bind its Account');
        const entry = await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', serverId: home.id, machineId: 'machine-1', accountLifetime });
        expect(entry).toMatchObject({ kind: 'ready' });
        const reader = captureDaemonMergedProjectionReader({ serverId: home.id, machineId: 'machine-1' });
        const hook = await renderHook(() => useDaemonMergedProjectionSummary({ serverId: home.id, machineId: 'machine-1' }));
        const resolve = vi.spyOn(serverProfiles, 'resolveServerProfileScopeIdForIdentifier');
        const capture = vi.spyOn(serverProfiles, 'captureServerProfileScopeResolver');
        try {
            const first = hook.getCurrent();
            expect(first.current).toBe(true);
            for (let index = 0; index < 3; index++) {
                await hook.rerender();
                expect(hook.getCurrent()).toBe(first);
                expect(reader.readSummary()).toBe(first);
            }
            expect(resolve).not.toHaveBeenCalled();
            expect(capture).not.toHaveBeenCalled();
        } finally { resolve.mockRestore(); capture.mockRestore(); await hook.unmount(); }
    } finally {
        await credential.unmount();
        standardCleanup();
        clearDaemonMergedProjectionCacheForTests();
        await serverScopedRpcSocketPool.stopAll();
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
    }
});
