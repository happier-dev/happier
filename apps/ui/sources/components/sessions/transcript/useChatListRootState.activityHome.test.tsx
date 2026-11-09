import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createSessionFixture, createMachineFixture, renderScreen, renderHook, act } from '@/dev/testkit';
import { clearMachineRequestReachabilityForTest, withdrawMachinePresenceForScope, captureMachinePresenceObservation } from '@/sync/domains/machines/reachability/machineReachability';
import { resolveExternalSessionOperationOriginAvailability } from '@/components/sessions/external/progress/externalSessionOperationProgressPresentation';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { Session } from '@/sync/domains/state/storageTypes';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createServerScopedMachineRpcBoundaryMock } from '@/dev/testkit/mocks/serverScopedRpc';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { configureConnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const daemon = vi.hoisted(() => ({ reply: vi.fn() }));
// Only the daemon network boundary is replaced; projection publication,
// transcript lifetime and Action admission remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () =>
    createServerScopedMachineRpcBoundaryMock(request => daemon.reply(request)));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const { storage } = await import('@/sync/domains/state/storage');
const { useChatListRootState } = await import('./useChatListRootState');
const { ChatListFooterWithKeyboardInset } = await import('./ChatListFrameSlots');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');
const { PluginContextualResourceStoreProvider } = await import('@/components/plugins/surfaces/PluginContextualResourceStoreProvider');

function RootActivity(props: Readonly<{ session: Session }>) {
    const { internalProps } = useChatListRootState({ session: props.session, sessionSurfaceKey: 'legacy-activity' });
    return <ChatListFooterWithKeyboardInset sessionId={internalProps.sessionId}
        serverId={internalProps.sessionServerId} showToolCalls={false} />;
}

describe('transcript root activity Home', () => {
    it('keeps whole-message Actions current through raw generation-only arrivals and refuses actual retirement', async () => {
        const http = createHomeHubArtifactHttpBoundary('transcript-action-account');
        const account = await restoreServerAccountForTest({ serverUrl: 'https://transcript-action-noise.test',
            accountId: 'transcript-action-account', request: http.request,
            configureSocket: configureConnectedServerSocketBoundary });
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { loadDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        const { createPluginContributedActionController } = await import('@/components/plugins/actions/pluginContributedActionController');
        const lifetime = captureActiveServerAccountScopeLifetime();
        expect(lifetime?.isCurrent()).toBe(true);
        let projection = PluginProjectionV2Schema.parse({ v: 2, generation: 7,
            installedPackagesById: { 'acme.transcript': { id: 'acme.transcript', displayName: 'Transcript', enabled: true,
                source: { kind: 'local', locator: '/plugins/transcript' } } },
            actionsById: { 'acme.transcript/review': { id: 'review', pluginId: 'acme.transcript', occurrenceId: 'transcript-occurrence',
                title: 'Review message', scopes: ['message'], surfaces: ['ui'], placementBindings: ['rowAction'],
                inputHints: { title: 'Review message', fields: [{ path: 'note', title: 'Note', widget: 'textarea' }] },
                execution: { target: 'daemon' }, dangerLevel: 'safe', available: true } },
        });
        let delaySchemas = false;
        let settleSchemas: ((value: unknown) => void) | undefined;
        let executions = 0;
        daemon.reply.mockImplementation(async (request: Readonly<{ method: string }>) => {
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection };
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) {
                if (delaySchemas) return await new Promise(resolve => { settleSchemas = resolve; });
                return { ok: true, inputSchema: {} };
            }
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                executions++;
                return { ok: true, result: { reviewed: true } };
            }
            throw new Error(`Unexpected transcript daemon request: ${request.method}`);
        });
        const session = createSessionFixture({ id: 'transcript-action-session', serverId: account.home.id, active: true });
        const machine = createMachineFixture({ id: 'machine-1', active: true, activeAt: Date.now() });
        storage.getState().applyMachines([machine], true, { sourceServerId: account.home.id });
        storage.getState().applySessions([session]);
        const read = () => loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: machine.id, serverId: account.home.id,
            accountLifetime: lifetime, reuseFreshReady: false });
        const initial = await read();
        expect(initial).toMatchObject({ kind: 'ready' });
        const hook = await renderHook(() => useChatListRootState({ session, sessionSurfaceKey: session.id }), {
            wrapper: ({ children }) => <AppSessionTranscriptSourceProvider sessionId={session.id} serverId={account.home.id} navigation="none">
                <PluginContextualResourceStoreProvider>{children}</PluginContextualResourceStoreProvider>
            </AppSessionTranscriptSourceProvider>,
        });
        const reference = { v: 1, sessionId: session.id, messageId: 'reviewed-message', observedRevision: 'message-revision' } as const;
        const controller = createPluginContributedActionController({
            resolveCurrent: () => hook.getCurrent().pluginMessageActionHost?.resolveCurrent(reference) ?? null,
        });
        try {
            await vi.waitFor(() => expect(controller.isReferenceAvailable({ pluginId: 'acme.transcript', localId: 'review' })).toBe(true));
            const host = hook.getCurrent().pluginMessageActionHost!;
            const original = host.resolveCurrent(reference)!;
            const action = controller.list({ placement: 'rowAction', scope: 'message' })[0]!;
            const presentation = await controller.open(action);
            if (presentation.kind !== 'form') throw new Error('Expected the declared message Action form');
            presentation.form.replaceInput({ note: 'Retained transcript draft' });
            for (let generation = 8; generation < 11; generation++) {
                projection = PluginProjectionV2Schema.parse({ ...projection, generation });
                let next!: Awaited<ReturnType<typeof read>>;
                await act(async () => { next = await read(); });
                if (initial?.kind !== 'ready' || next?.kind !== 'ready') throw new Error('Expected current projection publication');
                expect(next.inputs.pluginProjectionV2?.generation).toBe(generation);
                expect(next.inputs.pluginUiProjection).toBe(initial.inputs.pluginUiProjection);
                expect(controller.isReferenceAvailable({ pluginId: 'acme.transcript', localId: 'review' })).toBe(true);
                expect(hook.getCurrent().pluginMessageActionHost).toBe(host);
                expect(host.signal?.aborted).toBe(false);
                expect(original.host.isCurrent?.()).toBe(true);
                expect(presentation.form.isRetired()).toBe(false);
                expect(presentation.form.getInput()).toEqual({ note: 'Retained transcript draft' });
            }
            expect(await controller.invokeReference({ pluginId: 'acme.transcript', localId: 'review' }, {}))
                .toMatchObject({ kind: 'settled', outcome: { ok: true } });
            expect(executions).toBe(1);
            delaySchemas = true;
            const pending = controller.selectExactBoundActionInput({
                action: { pluginId: 'acme.transcript', localId: 'review' },
                expectedOccurrenceId: 'transcript-occurrence',
                invocationSurface: 'ui',
            });
            await vi.waitFor(() => expect(settleSchemas).toBeTypeOf('function'));
            projection = PluginProjectionV2Schema.parse({ ...projection, actionsById: {
                'acme.transcript/review': { ...projection.actionsById['acme.transcript/review'], occurrenceId: 'transcript-replacement' },
            } });
            await act(async () => { await read(); });
            expect(presentation.form.isRetired()).toBe(true);
            expect(hook.getCurrent().pluginMessageActionHost).not.toBe(host);
            expect(original.host.isActionCurrent?.({ pluginId: 'acme.transcript', localId: 'review' })).toBe(false);
            settleSchemas!({ ok: true, inputSchema: {} });
            await expect(pending).resolves.toEqual({ kind: 'unavailable', reason: 'action_not_found' });
            expect(executions).toBe(1);
            expect(controller.isReferenceAvailable({ pluginId: 'acme.transcript', localId: 'review' })).toBe(true);
            projection = PluginProjectionV2Schema.parse({ ...projection, installedPackagesById: {
                'acme.transcript': { ...projection.installedPackagesById['acme.transcript'], enabled: false },
            } });
            await act(async () => { await read(); });
            expect(controller.isReferenceAvailable({ pluginId: 'acme.transcript', localId: 'review' })).toBe(false);
            projection = PluginProjectionV2Schema.parse({ ...projection, installedPackagesById: {
                'acme.transcript': { ...projection.installedPackagesById['acme.transcript'], enabled: true },
            } });
            await act(async () => { await read(); });
            expect(controller.isReferenceAvailable({ pluginId: 'acme.transcript', localId: 'review' })).toBe(true);
            await act(async () => { await account.dispose(); });
            expect(original.host.accountLifetime?.isCurrent()).toBe(false);
            expect(controller.isReferenceAvailable({ pluginId: 'acme.transcript', localId: 'review' })).toBe(false);
        } finally { await hook.unmount(); await account.dispose(); }
    });
    it('keeps a retained operation origin unknown until its exact Home observes Machine presence again', async () => {
        const account = await restoreServerAccountForTest({ serverUrl: 'https://operation-presence.test', accountId: 'operation-account' });
        const now = Date.now();
        const machine = createMachineFixture({ id: 'machine-1', active: true, activeAt: now });
        const session = createSessionFixture({ id: 'operation-session', serverId: account.home.id, metadata: {
            ...createSessionFixture().metadata!, externalSessionOperationPresentationV1: {
                v: 1, operationId: 'operation-1', revision: 1, kind: 'materialize', status: 'running', phase: 'importing',
            },
        } });
        storage.getState().applyMachines([machine], true, { sourceServerId: account.home.id });
        storage.getState().applySessions([session]);
        const hook = await renderHook(() => useChatListRootState({ session, sessionSurfaceKey: 'operation-presence' }), {
            wrapper: ({ children }) => <AppSessionTranscriptSourceProvider sessionId={session.id} serverId={account.home.id} navigation="none">
                <PluginContextualResourceStoreProvider>{children}</PluginContextualResourceStoreProvider>
            </AppSessionTranscriptSourceProvider>,
        });
        const origin = () => {
            const target = hook.getCurrent().internalProps.externalSessionOperationOwnerTarget;
            expect(target).not.toBeNull();
            return resolveExternalSessionOperationOriginAvailability(target!);
        };
        try {
            expect(origin()).toBe('online');
            await act(async () => withdrawMachinePresenceForScope({ serverId: account.home.id, accountId: 'operation-account' }));
            expect(origin()).toBe('unknown');
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(now + 120_001);
            await act(async () => {
                storage.getState().applyMachines([{ ...machine, active: false, activeAt: now + 1 }], false, { sourceServerId: account.home.id });
                captureMachinePresenceObservation({ serverId: account.home.id, accountId: 'operation-account' })([machine.id]);
            });
            expect(origin()).toBe('offline');
        } finally {
            await hook.unmount();
            clearMachineRequestReachabilityForTest();
            vi.useRealTimers();
            await account.dispose();
        }
    });
    it('carries the canonical unique Home for a legacy Session shell without borrowing an unknown Session', async () => {
        const account = await restoreServerAccountForTest({ serverUrl: 'https://legacy-transcript-activity.test' });
        // A running turn: the hidden-tools activity line exists only while work runs.
        const live = createSessionFixture({ id: 'legacy-activity-session', serverId: account.home.id,
            active: true, activeAt: Date.now(), thinking: true, thinkingAt: Date.now(),
            latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: Date.now() });
        const legacyShell = { ...live, serverId: undefined };
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        const view = (session: Session) => <AppSessionTranscriptSourceProvider sessionId={session.id}
            serverId={account.home.id} navigation="none">
            <PluginContextualResourceStoreProvider><RootActivity session={session} /></PluginContextualResourceStoreProvider>
        </AppSessionTranscriptSourceProvider>;
        try {
            storage.getState().applySessions([live]);
            screen = await renderScreen(view(legacyShell));
            expect(screen.findByTestId('transcript-session-activity-status')).not.toBeNull();
            await screen.update(view({ ...legacyShell, id: 'unknown-session' }));
            expect(screen.findByTestId('transcript-session-activity-status')).toBeNull();
        } finally {
            await screen?.unmount();
            await account.dispose();
        }
    });
});
