import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { createConnectedPurposeCatalogHttpBoundary } from '@/dev/testkit/harness/connectedAccountCatalogBoundary';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { useSessionDraftPickerPresentation } from '@/dev/testkit/harness/sessionDraftPickerPresentation';
import { getSessionComposerDraftSnapshot, getSessionDraftSnapshot, resetSessionDraftRepositoryForTests, writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { useInSessionAgentPickerControls } from './useInSessionAgentPickerControls';
import type { SessionAgentContinuationSourceState } from './resolveSessionAgentContinuationEligibility';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
const machineRpc = vi.hoisted(() => vi.fn());
// Machine transport is the system boundary. Catalog, eligibility, draft and Action owners stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpc(params),
}));

const source: SessionAgentContinuationSourceState = {
    currentBackendTargetKey: 'agent:happier.agent.claude/claude', storageKind: 'persisted',
    canEditSession: true, machinePresence: 'online', hasConversationToCarry: true,
};
let scope: ServerAccountScope;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let sync: Awaited<ReturnType<typeof loadSyncSingletonForTests>>;
let inspectionAvailable = true;
const initialStorage = storage.getState();

beforeEach(async () => {
    sync = await loadSyncSingletonForTests();
    const purposes = createConnectedPurposeCatalogHttpBoundary();
    const http = createHomeHubArtifactHttpBoundary('account-1');
    account = await restoreServerAccountForTest({ serverUrl: 'https://session-draft-actions.test', accountId: 'account-1',
        request: async (input, init) => await purposes.handle(input, init) ?? http.request(input, init) });
    scope = { serverId: account.home.id, accountId: 'account-1' };
    await purposes.hydrate(scope);
    storage.setState({ sessions: { 'session-1': createSessionFixture({ id: 'session-1', serverId: scope.serverId,
        metadata: { machineId: 'machine-1', path: '/repo', flavor: 'claude' } }) } });
    resetSessionDraftRepositoryForTests();
    writeExistingSessionDraft({ scope, sessionId: 'session-1', materializationIntent: 'userEdit', patch: { text: 'Keep my unsent message' } });
    inspectionAvailable = true;
    machineRpc.mockReset();
    machineRpc.mockImplementation((params: { method: string; payload: { selections: readonly unknown[] } }) => {
        if (params.method !== RPC_METHODS.SESSION_CONTINUATION_INSPECT_BATCH) throw new Error('Draft edit attempted a runtime mutation');
        return Promise.resolve({ v: 1, inspections: params.payload.selections.map(() => ({
            type: 'available', protocolVersion: 1, sameSessionTransition: inspectionAvailable,
        })) });
    });
});
afterEach(async () => {
    await standardCleanup();
    resetSessionDraftRepositoryForTests();
    await account.dispose();
    sync.dispose();
    storage.setState(initialStorage, true);
});

async function mountPicker() {
    return await renderHook((accountScope: ServerAccountScope | null) => {
        const picker = useInSessionAgentPickerControls({ sessionId: 'session-1', accountScope,
            currentAgentId: 'claude', currentAgentLabel: 'Claude Code', projectionCurrent: true,
            entries: getResolvedBackendCatalogEntries({ enabledAgentIds: ['claude', 'codex'] }),
            featureDecision: { state: 'enabled' }, source,
            machine: { machineId: 'machine-1', serverId: scope.serverId, connectionGeneration: 1, daemonGeneration: 'daemon-1' },
            detail: { capabilityServerId: scope.serverId, machineId: 'machine-1', cwd: '/repo' } });
        useSessionDraftPickerPresentation(picker, accountScope, 'session-1');
        return picker;
    }, { initialProps: scope });
}

describe('mounted Session draft Actions', () => {
    it('arms the existing picker, changes its model, and leaves input and runtime untouched', async () => {
        const hook = await mountPicker();
        expect(machineRpc).not.toHaveBeenCalled();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, authority: 'account_automation' as const,
            serverId: scope.serverId, runtimeAccountId: scope.accountId };
        const ref = { kind: 'session' as const, sessionId: 'session-1' };
        await act(async () => {
            expect(await executor.execute('session.draft.agent.set', { ref, agent: { kind: 'picker',
                backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                selection: { modelId: 'chosen-model', sessionModeId: null, configOverrides: {} } } }, context))
                .toMatchObject({ ok: true, result: { status: 'applied' } });
        });
        expect(hook.getCurrent().armedContinuation?.selection).toMatchObject({ agentId: 'codex', modelId: 'chosen-model' });
        await act(async () => {
            expect(await executor.execute('session.draft.model.set', { ref, model: { kind: 'mode', modelId: 'second-model' } }, context))
                .toMatchObject({ ok: true, result: { status: 'applied' } });
        });
        expect(hook.getCurrent().armedContinuation?.selection.modelId).toBe('second-model');
        const draft = getSessionDraftSnapshot(scope, ref);
        expect(getSessionComposerDraftSnapshot(scope, ref)?.composer.text.value).toBe('Keep my unsent message');
        expect(draft?.document.target.kind === 'session' && draft.document.target.routing.agentContinuation.value).toMatchObject({
            intent: { sourceAgentId: 'claude', selection: { agentId: 'codex', modelId: 'second-model' } },
        });
        expect(machineRpc.mock.calls.every(([request]) => request.method === RPC_METHODS.SESSION_CONTINUATION_INSPECT_BATCH)).toBe(true);
        expect(machineRpc).toHaveBeenCalledTimes(2);
    });

    it('leaves a stale Account draft unarmed when the pending inspection settles', async () => {
        const hook = await mountPicker();
        let answer: ((result: unknown) => void) | undefined;
        machineRpc.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const pending = createDefaultActionExecutor().execute('session.draft.agent.set', {
            ref: { kind: 'session', sessionId: 'session-1' }, agent: { kind: 'picker',
                backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                selection: { modelId: 'default', sessionModeId: null, configOverrides: {} } },
        }, { surface: 'agent', authority: 'account_automation', serverId: scope.serverId, runtimeAccountId: scope.accountId });
        await vi.waitFor(() => expect(answer).toBeDefined());
        expect(hook.getCurrent().armedContinuation).toBeNull();
        await hook.rerender(null);
        answer?.({ v: 1, inspections: [{ type: 'available', protocolVersion: 1, sameSessionTransition: true }] });
        await act(async () => expect(await pending).toMatchObject({ ok: true, result: { status: 'unavailable' } }));
        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(getSessionComposerDraftSnapshot(scope, { kind: 'session', sessionId: 'session-1' })?.composer.text.value).toBe('Keep my unsent message');
    });

    it.each(['foreign Account', 'foreign Home', 'contradictory expected identity'])('rejects %s targeting the mounted Session', async wrongScope => {
        const hook = await mountPicker();
        const { createAppShellAction } = await import('@/sync/ops/actions/appShellAction');
        const result = await createAppShellAction()({ actionId: 'session.draft.agent.set', input: {
            ref: { kind: 'session', sessionId: 'session-1' }, agent: { kind: 'picker',
                backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                selection: { modelId: 'default', sessionModeId: null, configOverrides: {} } },
        }, context: { surface: 'agent', authority: 'account_automation',
            serverId: wrongScope === 'foreign Home' ? 'other-home' : scope.serverId,
            runtimeAccountId: wrongScope === 'foreign Home' ? scope.accountId : 'other-account',
            ...(wrongScope === 'contradictory expected identity' ? { expectedAccountId: scope.accountId } : {}) } });
        expect(result).toMatchObject({ status: 'unavailable' });
        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(machineRpc).not.toHaveBeenCalled();
    });

    it('refuses a new arm while the draft retains a submitted input snapshot', async () => {
        const hook = await mountPicker();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, authority: 'account_automation' as const,
            serverId: scope.serverId, runtimeAccountId: scope.accountId };
        const ref = { kind: 'session' as const, sessionId: 'session-1' };
        const agent = { kind: 'picker' as const,
            backendTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            selection: { modelId: 'chosen-model', sessionModeId: null, configOverrides: {} } };
        await act(async () => {
            expect(await executor.execute('session.draft.agent.set', { ref, agent }, context))
                .toMatchObject({ ok: true, result: { status: 'applied' } });
        });
        const localId = hook.getCurrent().armedContinuationLocalId;
        if (!localId) throw new Error('Expected the arm submission identity');
        const submission = { localId, input: { localId, text: 'Submitted input', meta: {} },
            currentness: { text: 'Submitted input', mentions: [], composerAttachments: [], attachmentDraftIds: [] } };
        await act(async () => expect(hook.getCurrent().recordArmedContinuationSubmission(submission)).toBe(true));
        await act(async () => {
            expect(await executor.execute('session.draft.agent.set', { ref, agent: { ...agent,
                backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } }, context))
                .toMatchObject({ ok: true, result: { status: 'applied' } });
        });
        expect(hook.getCurrent().armedContinuation).toBeNull();
        await act(async () => {
            expect(await executor.execute('session.draft.agent.set', { ref, agent }, context))
                .toMatchObject({ ok: true, result: { status: 'unavailable' } });
        });
        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(hook.getCurrent().armedContinuationSubmission).toEqual(submission);
        expect(machineRpc).toHaveBeenCalledTimes(1);
    });

    it('keeps the latest choice when exact inspections answer out of order', async () => {
        const hook = await mountPicker();
        const answers = new Map<string, (result: unknown) => void>();
        machineRpc.mockImplementation((params: { payload: { selections: readonly { modelId: string }[] } }) => (
            new Promise(resolve => answers.set(params.payload.selections[0]!.modelId, resolve))
        ));
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const choose = (modelId: string) => executor.execute('session.draft.agent.set', {
            ref: { kind: 'session', sessionId: 'session-1' }, agent: { kind: 'picker',
                backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                selection: { modelId, sessionModeId: null, configOverrides: {} } },
        }, { surface: 'agent', authority: 'account_automation', serverId: scope.serverId, runtimeAccountId: scope.accountId });
        const first = choose('first-model');
        await vi.waitFor(() => expect(answers.has('first-model')).toBe(true));
        const latest = choose('latest-model');
        await vi.waitFor(() => expect(answers.has('latest-model')).toBe(true));
        const available = { v: 1, inspections: [{ type: 'available', protocolVersion: 1, sameSessionTransition: true }] };
        await act(async () => {
            answers.get('latest-model')!(available);
            expect(await latest).toMatchObject({ ok: true, result: { status: 'applied' } });
        });
        await act(async () => {
            answers.get('first-model')!(available);
            expect(await first).toMatchObject({ ok: true, result: { status: 'unavailable' } });
        });
        expect(hook.getCurrent().armedContinuation?.selection.modelId).toBe('latest-model');
    });

    it('refuses a model binding belonging to another Agent before inspecting or arming', async () => {
        const hook = await mountPicker();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const result = await createDefaultActionExecutor().execute('session.draft.agent.set', {
            ref: { kind: 'session', sessionId: 'session-1' }, agent: { kind: 'picker',
                backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                selection: { modelId: 'chosen-model', sessionModeId: null, configOverrides: {},
                    modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'agent:happier.agent.claude/claude',
                        providerConnectionId: null, modelId: 'chosen-model' } } } },
        }, { surface: 'agent', authority: 'account_automation', serverId: scope.serverId, runtimeAccountId: scope.accountId });
        expect(result).toMatchObject({ ok: true, result: { status: 'unavailable' } });
        expect(hook.getCurrent().armedContinuation).toBeNull();
        expect(machineRpc).not.toHaveBeenCalled();
    });

    it('refuses an unavailable target and model edits without an armed continuation', async () => {
        const hook = await mountPicker();
        inspectionAvailable = false;
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, authority: 'account_automation' as const,
            serverId: scope.serverId, runtimeAccountId: scope.accountId };
        await act(async () => {
            expect(await executor.execute('session.draft.agent.set', { ref: { kind: 'session', sessionId: 'session-1' },
                agent: { kind: 'picker', backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                    selection: { modelId: 'default', sessionModeId: null, configOverrides: {} } } }, context))
                .toMatchObject({ ok: true, result: { status: 'unavailable' } });
            expect(await executor.execute('session.draft.model.set', { ref: { kind: 'session', sessionId: 'session-1' },
                model: { kind: 'mode', modelId: 'chosen-model' } }, context))
                .toMatchObject({ ok: true, result: { status: 'unavailable' } });
        });
        expect(hook.getCurrent().armedContinuation).toBeNull();
    });
});
