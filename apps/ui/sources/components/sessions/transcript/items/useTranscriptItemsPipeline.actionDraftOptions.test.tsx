import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createServerScopedMachineRpcBoundaryMock } from '@/dev/testkit/mocks/serverScopedRpc';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { CapabilitiesDetectResponse } from '@happier-dev/protocol/capabilities';
import { CANONICAL_AGENT_IDS } from '@/agents/registry/registryCore';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import { useSessionActionFieldOptions, useSessionActionFieldOptionsForRowHeight } from '@/components/sessions/actions/useSessionActionFieldOptions';
import { prefetchMachineCapabilities } from '@/hooks/server/useMachineCapabilitiesCache';
import { buildTranscriptItemHeightSignatureKey } from '@/components/sessions/transcript/measurement/transcriptItemHeightCache';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { getStorage } from '@/sync/domains/state/storage';
import type { StorageState } from '@/sync/store/types';
import type { SessionActionDraft } from '@/sync/domains/sessionActions/sessionActionDraftTypes';
import { useTranscriptItemsPipeline } from './useTranscriptItemsPipeline';

type Deps = Parameters<typeof useTranscriptItemsPipeline>[0];
const daemon = vi.hoisted(() => {
    const calls: string[] = [];
    const backends: Record<string, { available: boolean; intents: string[]; title: string }> = {};
    return { calls, backends, channelDisabled: false };
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => createServerScopedMachineRpcBoundaryMock(async (request) => {
    daemon.calls.push(request.method);
    if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return {
        protocolVersion: 1,
        results: { 'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { backends: daemon.backends } } },
    } satisfies CapabilitiesDetectResponse;
    if (request.method === 'action.options.resolve') return {
        actionId: null, fieldPath: null, optionsSourceId: 'notifications.channels.available',
        options: [{ value: 'plugin/channel', label: 'Plugin channel', disabled: daemon.channelDisabled }],
    };
    // This daemon has no external Agent UI contributions; bundled Agent choices remain real.
    if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
        return { errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
    }
    throw new Error('Unexpected daemon RPC: ' + request.method);
}));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const disposeLoader = await installRealActionExecutorModuleLoader();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let fixtureIndex = 0;
let serverId: string;
let draft: SessionActionDraft;
const engineField = { path: 'engineIds', optionsSourceId: 'review.engines.available' };
const channelField = { path: 'channels', optionsSourceId: 'notifications.channels.available' };
const messageItem = { id: 'm1', kind: 'message' as const, messageId: 'm1', seq: 1, createdAt: 1 };
const vendorId = 'vendor-review-service';
function Source(props: React.PropsWithChildren) {
    return <AppSessionTranscriptSourceProvider sessionId="s1" serverId={serverId}>{props.children}</AppSessionTranscriptSourceProvider>;
}
async function writeStore(patch: Partial<StorageState>) {
    await act(async () => { getStorage().setState(patch); });
}
function session(machineId = 'machine-1', updatedAt = 1) {
    return createSessionFixture({
        id: 's1', serverId, active: true, updatedAt,
        metadata: { path: '/workspace', host: 'tester.local', machineId },
    });
}
async function setDrafts(values: SessionActionDraft[]) {
    await writeStore({ sessionActionDraftsByAddressKey: { [JSON.stringify([serverId, 's1'])]: values } });
}
function deps(resolveActionDraftFieldOptions: Deps['resolveActionDraftFieldOptions']): Deps {
    const items = [messageItem, { id: 'draft:d1', kind: 'action-draft' as const, draft }];
    return {
        activeTargetWindowTargetRef: { current: null },
        activeThinkingMessageId: null,
        canonicalWindowedItemsRef: { current: items },
        committedMessagesCount: 1,
        expandedToolCallsAnchorMessageIds: new Set(),
        forkMessageMetadataById: null,
        getMessageById: () => null,
        getMessageRevisionById: () => 1,
        groupingMode: 'linear',
        isLoaded: true,
        items,
        itemsRef: { current: items },
        latestCommittedActivityKey: null,
        listDataRef: { current: items },
        listOrientation: 'standard',
        messagesById: {},
        preDecompositionItemsRef: { current: items },
        renderWindowIndexMapRef: { current: null },
        resolveActionDraftFieldOptions,
        resolveThinkingExpanded: () => false,
        rowFontScaleKey: 'default',
        rowWidthBucket: 'w',
        sessionActive: true,
        sessionId: 's1',
        sessionThinking: false,
        targetWindowActiveRef: { current: false },
        transcriptToolCallsCollapsedPreviewCountSetting: 3,
    };
}
async function renderPipeline(card = false) {
    let runs = 0;
    const stableDeps = deps(() => []);
    const hook = await renderHook(() => {
        runs += 1;
        const resolver = useSessionActionFieldOptionsForRowHeight('s1', serverId);
        const cardResolver = useSessionActionFieldOptions('s1', serverId);
        return {
            resolver,
            cardResolver,
            pipeline: useTranscriptItemsPipeline({ ...stableDeps, resolveActionDraftFieldOptions: resolver }),
        };
    }, { wrapper: Source });
    const read = () => {
        const value = hook.getCurrent();
        return {
            ...value,
            runs,
            draftKey: buildTranscriptItemHeightSignatureKey(value.pipeline.buildRowShellSignature(stableDeps.items[1]!)),
            messageKey: buildTranscriptItemHeightSignatureKey(value.pipeline.buildRowShellSignature(messageItem)),
        };
    };
    await vi.waitFor(() => {
        const resolver = card ? hook.getCurrent().cardResolver : hook.getCurrent().resolver;
        const field = card ? channelField : engineField;
        expect(resolver.state?.(field)).toMatchObject({ status: 'ready' });
        expect(resolver(field).length).toBeGreaterThan(0);
    });
    return { hook, read };
}
async function refreshCapabilities() {
    await act(async () => {
        await prefetchMachineCapabilities({
            machineId: 'machine-1', serverId,
            request: { requests: [{ id: 'tool.executionRuns' }], bypassCache: true },
        });
    });
}
beforeEach(async () => {
    daemon.calls.length = 0;
    daemon.backends = {};
    daemon.channelDisabled = false;
    const http = createHomeHubArtifactHttpBoundary('account-a');
    // Each test has a fresh real Home namespace, not a reset or forged cache.
    fixtureIndex += 1;
    connection = await restoreServerAccountForTest({ serverUrl: `http://transcript-options-${fixtureIndex}.test`, accountId: 'account-a', request: http.request });
    serverId = captureActiveServerAccountScopeLifetime()!.scope.serverId;
    draft = { id: 'd1', address: { serverId, sessionId: 's1' }, accountId: 'account-a', actionId: 'review.start', createdAt: 1,
        status: 'editing', input: { engineIds: [CANONICAL_AGENT_IDS[1]!], instructions: 'Review.', changeType: 'all', base: { kind: 'none' } } };
    const machines = [createMachineFixture({ id: 'machine-1', activeAt: Date.now() }), createMachineFixture({ id: 'machine-2', activeAt: Date.now() })];
    await writeStore({ sessions: { s1: session() }, machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [serverId]: machines }, settings: { ...getStorage().getState().settings, backendEnabledByTargetKey: {} } });
    await setDrafts([draft]);
});
afterEach(async () => { await connection.dispose(); });
// The loader only bridges Metro's call-time require; no Action behavior is replaced.
afterAll(disposeLoader);

describe('transcript action-draft option key locality', () => {
    it('preserves unrelated row keys and only changes the draft geometry for changed options', async () => {
        const { hook, read } = await renderPipeline(); const baseline = read();
        await writeStore({ settings: { ...getStorage().getState().settings, transcriptScrollPinEnabled: false } });
        expect(read().runs).toBe(baseline.runs); expect(read().resolver).toBe(baseline.resolver);
        await writeStore({ settings: { ...getStorage().getState().settings, backendEnabledByTargetKey: { 'unknown-target': false } } });
        expect(read().resolver).toBe(baseline.resolver); expect(read().draftKey).toBe(baseline.draftKey);
        await writeStore({ settings: { ...getStorage().getState().settings, backendEnabledByTargetKey: { [buildAgentUniverseBackendTargetKey(CANONICAL_AGENT_IDS[0]!)]: false } } });
        await vi.waitFor(() => expect(read().draftKey).not.toBe(baseline.draftKey));
        expect(read().messageKey).toBe(baseline.messageKey); await hook.unmount();
    });
    it('does not probe capabilities without a draft and starts the real read when a draft appears', async () => {
        await setDrafts([]); daemon.calls.length = 0;
        const hook = await renderHook(() => useSessionActionFieldOptionsForRowHeight('s1', serverId), { wrapper: Source });
        expect(hook.getCurrent()(engineField)).toEqual([]);
        expect(daemon.calls).not.toContain(RPC_METHODS.CAPABILITIES_DETECT);
        await setDrafts([draft]);
        await vi.waitFor(() => {
            expect(hook.getCurrent()(engineField).length).toBeGreaterThan(0);
            expect(daemon.calls).toContain(RPC_METHODS.CAPABILITIES_DETECT);
        });
        await hook.unmount();
    });
    it('re-keys only the draft when the real capabilities snapshot adds or renames an option', async () => {
        const { hook, read } = await renderPipeline(); const baseline = read();
        daemon.backends = { [vendorId]: { available: true, intents: ['review'], title: 'Vendor Review' } };
        await refreshCapabilities();
        await vi.waitFor(() => expect(read().resolver(engineField).map(option => option.label)).toContain('Vendor Review'));
        const discovered = read(); expect(discovered.draftKey).not.toBe(baseline.draftKey);
        daemon.backends = { [vendorId]: { available: true, intents: ['review'], title: 'Vendor Review Bot' } };
        await refreshCapabilities();
        await vi.waitFor(() => expect(read().resolver(engineField).map(option => option.label)).toContain('Vendor Review Bot'));
        expect(read().draftKey).not.toBe(discovered.draftKey); expect(read().messageKey).toBe(baseline.messageKey); await hook.unmount();
    });
    it('keeps row geometry when a declared notification option only changes availability', async () => {
        draft = { ...draft, actionId: 'notifications.notify_me', input: { message: 'Ready', channels: ['plugin/channel'] } }; await setDrafts([draft]);
        const { hook, read } = await renderPipeline(true); const baseline = read();
        expect(baseline.cardResolver(channelField)[0]?.disabled).not.toBe(true);
        daemon.channelDisabled = true; await act(async () => { hook.getCurrent().cardResolver.retry?.(); });
        await vi.waitFor(() => expect(read().cardResolver(channelField)[0]?.disabled).toBe(true));
        expect(read().resolver).toBe(baseline.resolver); expect(read().draftKey).toBe(baseline.draftKey); await hook.unmount();
    });
    it('does not rerender option consumers for unrelated session data and observes the real machine change', async () => {
        const { hook, read } = await renderPipeline(); const baseline = read();
        await writeStore({ sessions: { s1: session('machine-1', 2) } });
        expect(read().runs).toBe(baseline.runs); expect(read().resolver).toBe(baseline.resolver);
        await writeStore({ sessions: { s1: session('machine-2', 3) } });
        expect(read().runs).toBeGreaterThan(baseline.runs); await hook.unmount();
    });
});
