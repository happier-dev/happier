import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createWorkflowAutomationHttpBoundary } from '@/dev/testkit/harness/workflowAutomationHttpBoundary';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getWorkflowDefinition } from '@/sync/domains/workflows/workflowDefinitionActions';
import { readWorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';
import type { WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows/workflowV1';
import * as authoring from './useWorkflowSentenceDraft';
import { editWorkflowTriggerDraft } from '../triggers/workflowTriggerDraft';

// Expo's native randomness adapter is outside the Node host renderer.
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
let disposeHome: (() => Promise<void>) | undefined;
let disposeLoader: (() => void) | undefined;
afterEach(async () => { await standardCleanup(); await disposeHome?.(); disposeHome = undefined; disposeLoader?.(); disposeLoader = undefined; });

const message: WorkflowActionLeafV1 = { kind: 'action', id: 'message', actionId: 'session.message.send', input: {
    sessionId: { kind: 'literal', value: 'addressed-session' }, message: { kind: 'literal', value: 'Deployment failed' },
} };
const trigger = { kind: 'schedule', enabled: true,
    schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } } as const;

async function sourceHome() {
    disposeLoader = await installRealActionExecutorModuleLoader();
    const accountId = 'sentence-author';
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: 'plain' });
    const automations = createWorkflowAutomationHttpBoundary();
    const creates: unknown[] = [];
    const requests: string[] = [];
    let beforeCreate: (() => Promise<Response | undefined>) | undefined;
    const restored = await restoreServerAccountForTest({ serverUrl: 'https://sentence-authoring.test', accountId,
        configureSocket: configureConnectedServerSocketBoundary,
        request: async (input, init) => {
            const url = new URL(String(input));
            requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            const machine = createPlainMachineReadHttpResponseFixture(url.pathname, init, accountId);
            if (machine) return machine;
            if (url.pathname === '/v1/artifacts' && init?.method === 'POST') {
                creates.push(JSON.parse(String(init.body)));
                const intercepted = await beforeCreate?.();
                if (intercepted) return intercepted;
            }
            return await automations.handle(url, init) ?? await artifacts.handle(url.pathname + url.search, init)
                ?? createEmptyAccountBootstrapHttpResponse(url.pathname, init);
        } });
    disposeHome = restored.dispose;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected the sentence Account');
    return { creates, requests, automations, lifetime, interceptCreate: (intercept: typeof beforeCreate) => { beforeCreate = intercept; } };
}

it('saves a mounted sentence once through the real definition and trigger Actions without executing its verb', async () => {
    const home = await sourceHome();
    const hook = await renderHook(() => authoring.useWorkflowSentenceDraft({ name: 'Notify', step: message, trigger,
        project: { machineId: 'machine-a', directory: '/repo' } }, home.lifetime));
    expect(home.creates).toEqual([]);
    expect(home.automations.creates).toEqual([]);
    await act(async () => hook.getCurrent().onChange({ ...hook.getCurrent().draftStore.get(), name: 'Notify production' }));
    await act(async () => { const outcome = await hook.getCurrent().save(); expect(outcome, JSON.stringify(home.requests)).toEqual({ status: 'applied' }); });
    expect(home.creates).toHaveLength(1);
    expect(home.automations.creates).toHaveLength(1);
    expect(home.automations.creates[0]).toMatchObject({ triggers: [{ trigger }] });
    const saved = await getWorkflowDefinition({ definitionId: hook.getCurrent().saved!.definitionId, accountLifetime: home.lifetime });
    expect(saved).toMatchObject({ metadata: { title: 'Notify production' }, definition: { blocks: [message] } });
    await act(async () => { expect(await hook.getCurrent().save()).toEqual({ status: 'unchanged' }); });
    expect(home.creates).toHaveLength(1);
    expect(home.automations.creates).toHaveLength(1);
});

it('retains the failed create identity and current edits, then uses the ordinary revision owner on retry', async () => {
    const home = await sourceHome();
    home.interceptCreate(async () => Response.json({ error: 'storage_unavailable' }, { status: 503 }));
    const hook = await renderHook(() => authoring.useWorkflowSentenceDraft({ name: 'Before', step: message }, home.lifetime));
    await act(async () => { expect(await hook.getCurrent().save()).toMatchObject({ status: 'refused' }); });
    expect(hook.getCurrent().failed).toBeTruthy();
    await act(async () => hook.getCurrent().onChange({ ...hook.getCurrent().draftStore.get(), name: 'After' }));
    home.interceptCreate(undefined);
    await act(async () => { expect(await hook.getCurrent().save()).toEqual({ status: 'applied' }); });
    expect(home.creates.length).toBeGreaterThanOrEqual(2);
    expect(home.creates.every(input => JSON.stringify(input) === JSON.stringify(home.creates[0]))).toBe(true);
    expect(hook.getCurrent().draftStore.get().name).toBe('After');
    const saved = await getWorkflowDefinition({ definitionId: hook.getCurrent().saved!.definitionId, accountLifetime: home.lifetime });
    expect(saved.metadata.title).toBe('After');
    expect(hook.getCurrent().failed).toBeNull();
});

it('admits declared Action operands once while a save is pending', async () => {
    const home = await sourceHome();
    const accepted = createDeferred<void>();
    const entered = createDeferred<void>();
    home.interceptCreate(async () => { entered.resolve(); await accepted.promise; return undefined; });
    const actionStep: WorkflowActionLeafV1 = { ...message, input: { ...message.input,
        message: { kind: 'trigger_event', event: { kind: 'action', phase: 'before' }, path: ['requestId'] },
    } };
    const hook = await renderHook(() => authoring.useWorkflowSentenceDraft({ name: 'Audit', step: actionStep,
        trigger: { kind: 'action', phase: 'before', actionIds: ['scm.commit.create'], enabled: true },
        project: { machineId: 'machine-a', directory: '/repo' },
    }, home.lifetime));
    let saving: ReturnType<ReturnType<typeof hook.getCurrent>['save']> | undefined;
    await act(async () => { saving = hook.getCurrent().save(); await entered.promise; });
    expect(hook.getCurrent().saving).toBe(true);
    await act(async () => { expect(await hook.getCurrent().save()).toEqual({ status: 'refused', reason: 'save_pending' }); });
    await act(async () => { accepted.resolve(); expect(await saving, JSON.stringify({ requests: home.requests,
        triggers: home.automations.creates.map(row => row.triggers) })).toEqual({ status: 'applied' }); });
    expect(home.creates).toHaveLength(1);
    expect(home.automations.creates).toHaveLength(1);
    expect(hook.getCurrent().saving).toBe(false);
    const saved = await getWorkflowDefinition({ definitionId: hook.getCurrent().saved!.definitionId, accountLifetime: home.lifetime });
    expect(saved.definition.blocks).toEqual([actionStep]);
});

it('keeps history and current operands when opening the full editor, and refuses a retired Account save', async () => {
    const home = await sourceHome();
    const hook = await renderHook(() => authoring.useWorkflowSentenceDraft({ name: 'Notify', step: message, trigger }, home.lifetime));
    const edited = { ...message, input: { ...message.input, message: { kind: 'literal' as const, value: 'Edited message' } } };
    await act(async () => hook.getCurrent().changeStep(edited));
    await act(async () => hook.getCurrent().history.undo());
    expect(hook.getCurrent().draftStore.get().blocks).toEqual([message]);
    await act(async () => hook.getCurrent().history.redo());
    const later = { ...trigger, schedule: { ...trigger.schedule, scheduleExpr: '0 12 * * *' } };
    const clientId = hook.getCurrent().triggers.draft.adds[0]!.clientId;
    await act(async () => hook.getCurrent().triggers.setDraft(editWorkflowTriggerDraft(hook.getCurrent().triggers.draft,
        { kind: 'add', clientId, trigger: later })));
    await act(async () => hook.getCurrent().history.undo());
    expect(hook.getCurrent().triggers.draft.adds[0]!.trigger).toEqual(trigger);
    await act(async () => hook.getCurrent().history.redo());
    const entry = hook.getCurrent().openInEditor();
    if (!entry) throw new Error('Expected the ordinary editor entry');
    expect(readWorkflowDefinitionDraftSeed(entry.params.definitionDraftSeedId, home.lifetime.scope))
        .toMatchObject({ definition: { blocks: [edited] }, trigger: later });
    await hook.rerender();
    expect(hook.getCurrent().draftStore.get().blocks).toEqual([edited]);
    await disposeHome?.(); disposeHome = undefined;
    await act(async () => { expect(await hook.getCurrent().save()).toEqual({ status: 'unavailable' }); });
    expect(home.creates).toEqual([]);
});

it('saves and hands over the place the sentence chose, not the place it started from', async () => {
    const home = await sourceHome();
    const hook = await renderHook(() => authoring.useWorkflowSentenceDraft({ name: 'Notify', step: message, trigger,
        project: { machineId: 'machine-a', directory: '/repo' } }, home.lifetime));
    const chosen = { machineId: 'machine-b', directory: '/srv/app' };
    await act(async () => hook.getCurrent().changeProject(chosen));
    expect(hook.getCurrent().project).toEqual(chosen);
    const entry = hook.getCurrent().openInEditor();
    if (!entry) throw new Error('Expected the ordinary editor entry');
    expect(readWorkflowDefinitionDraftSeed(entry.params.definitionDraftSeedId, home.lifetime.scope)).toMatchObject({ project: chosen });
    await act(async () => { expect(await hook.getCurrent().save()).toEqual({ status: 'applied' }); });
    expect(JSON.stringify(home.automations.creates[0])).toContain('machine-b');
    expect(JSON.stringify(home.automations.creates[0])).not.toContain('machine-a');
});
