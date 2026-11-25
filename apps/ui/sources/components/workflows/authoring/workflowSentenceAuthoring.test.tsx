import 'fake-indexeddb/auto';
import { createRef } from 'react';
import type { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { t } from '@/text';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture, createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWorkflowAutomationHttpBoundary } from '@/dev/testkit/harness/workflowAutomationHttpBoundary';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getWorkflowDefinition } from '@/sync/domains/workflows/workflowDefinitionActions';
import { readWorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import type { WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows/workflowV1';
import { WORKFLOW_AUTHORING_ACTION_ID } from '@happier-dev/protocol/actions/workflowAuthoringActionIds';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import * as authoring from './useWorkflowSentenceDraft';
import { createSessionWorkflowSentenceIntent } from './workflowSentenceAuthoring';
import { editWorkflowTriggerDraft } from '../triggers/workflowTriggerDraft';
import { useWorkflowSessionBinding } from '../editor/useWorkflowSessionBinding';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { buildUiActionDispatchRequestV1, UiActionChildExecuteRequestV1Schema } from '@happier-dev/protocol/actions/clientDispatchV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createUiClientActionReverseHandler } from '@/sync/ops/actions/clientActionReverseDispatch';

// The invoking host supplies the Session's admission facts before the Action reaches the editor.
const agentCaller = { kind: 'session', sessionId: 'lifetime-session', starterDepth: 0, turnDepth: 0 } as const;
const sentenceAgentContext = {
    surface: 'agent', authority: 'account_automation', actionCaller: agentCaller,
    callerPermissionMode: 'default',
    agentStartContext: { caller: agentCaller, baseline: { machineId: 'machine-a', directory: '/repo' },
        ledSubtreeSessionIds: [], roles: {}, workDepthLimit: 4, callerPermissionCeiling: 'default' },
} as const;

const sentenceSaveRequestId = 'mounted-sentence-save';
type SentenceChild = ReturnType<typeof UiActionChildExecuteRequestV1Schema.parse>;

async function mountAgentSentence(home: Awaited<ReturnType<typeof sourceHome>>, onClose?: () => void) {
    const hook = await renderHook(() => {
        const sentence = authoring.useWorkflowSentenceDraft({ name: 'Notify',
            step: { ...message, input: { ...message.input, sessionId: { kind: 'literal', value: agentCaller.sessionId } } }, trigger,
            project: { machineId: 'machine-a', directory: '/repo' } }, home.lifetime, onClose);
        useWorkflowSessionBinding({ context: { scope: home.lifetime.scope, draft: sentence.draftStore.get(), editable: true,
            whereMachineId: sentence.project?.machineId ?? null, candidates: [] }, onChange: sentence.onChange,
            whereName: null, machineName: id => id, draftActions: sentence.draftActions });
        return sentence;
    });
    const address = { scope: home.lifetime.scope, draftId: hook.getCurrent().draftStore.get().draftId };
    const receive = createUiClientActionReverseHandler({ ...home.lifetime.scope, machineId: 'machine-a',
        isCurrent: () => home.lifetime.isCurrent() });
    const save = () => receive(buildUiActionDispatchRequestV1({
        actionId: 'workflow.authoring.draft.save', input: address,
        context: { ...sentenceAgentContext, serverId: home.lifetime.scope.serverId,
            expectedAccountId: home.lifetime.scope.accountId, defaultSessionId: agentCaller.sessionId,
            actionRequestId: sentenceSaveRequestId },
    }), { signal: new AbortController().signal });
    return { hook, address, save };
}

it.each([false, true])('uses Action policy enabled=%s for a native sentence Save', async enabled => {
    const home = await sourceHome(enabled ? undefined : WORKFLOW_AUTHORING_ACTION_ID.draftSave);
    const close = vi.fn();
    const { hook } = await mountAgentSentence(home, close);
    await act(async () => { await hook.getCurrent().saveFromUi(); });
    expect(home.creates).toHaveLength(enabled ? 1 : 0);
    expect(close).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(hook.getCurrent().failed === null).toBe(enabled);
});

it.each([false, true])('uses Action policy enabled=%s for a native sentence Cancel', async enabled => {
    const home = await sourceHome(enabled ? undefined : WORKFLOW_AUTHORING_ACTION_ID.draftDiscard);
    const { WorkflowSentenceBuilder } = await import('../sentence/WorkflowSentenceBuilder');
    const close = vi.fn();
    const restorePopover = withPopoverWebGlobals();
    try {
        const screen = await renderScreen(<WorkflowSentenceBuilder anchorRef={createRef<View>()}
            intent={{ name: 'Keep this draft', trigger }} accountLifetime={home.lifetime} onRequestClose={close} />, {
            createNodeMock: element => element.type === 'View' ? {
                addEventListener() {},
                removeEventListener() {},
                measureInWindow: callback => callback(0, 0, 300, 40),
            } satisfies Pick<View, 'measureInWindow'> & Pick<EventTarget, 'addEventListener' | 'removeEventListener'> : null,
        });
        try {
            await screen.pressByTestIdAsync('workflow-builder-cancel');
            await vi.waitFor(() => {
                if (enabled) expect(close).toHaveBeenCalledTimes(1);
                else expect(screen.findHostByTestId('workflow-builder-failed')).not.toBeNull();
            });
            expect(close).toHaveBeenCalledTimes(enabled ? 1 : 0);
            expect(home.creates).toEqual([]);
        } finally {
            await screen.unmount();
        }
    } finally {
        restorePopover();
    }
});

it('authors the mounted sentence through Actions with shared history and caller-scoped Save', async () => {
    const home = await sourceHome();
    let closed = false;
    const { hook, address, save } = await mountAgentSentence(home, () => { closed = true; });
    const executor = createDefaultActionExecutor();
    const context = { ...sentenceAgentContext,
        serverId: home.lifetime.scope.serverId, runtimeAccountId: home.lifetime.scope.accountId };
    const read = async () => {
        const result = await executor.execute('workflow.authoring.draft.get', address, context);
        expect(result).toMatchObject({ ok: true, result: { status: 'available' } });
        if (!result.ok || !result.result || typeof result.result !== 'object' || !('drafts' in result.result)) throw new Error('Missing mounted draft');
        const { WorkflowDraftGetResultV1Schema } = await import('@happier-dev/protocol/actions/workflowAuthoringAction');
        const parsed = WorkflowDraftGetResultV1Schema.parse(result.result);
        if (parsed.status !== 'available') throw new Error('Missing mounted draft');
        return parsed.drafts[0]!;
    };
    const initial = await read();
    expect(initial.settings.triggers.rows).toHaveLength(1);
    await act(async () => {
        expect(await executor.execute('workflow.authoring.draft.edit', { ...address,
            expectedDraftRevision: initial.draftRevision,
            triggerEdit: { kind: 'removeAdded', clientId: initial.settings.triggers.rows[0]!.identity.clientId },
        }, context)).toMatchObject({ ok: true, result: { status: 'refused', reason: 'invalid_parameters' } });
    });
    expect(await read()).toEqual(initial);
    await act(async () => {
        expect(await executor.execute('workflow.authoring.draft.edit', { ...address,
            expectedDraftRevision: initial.draftRevision, ops: [{ kind: 'rename', name: 'Agent notice' }],
            settings: { description: 'Authored together', projectTarget: { machineId: 'machine-a', directory: '/other' }, executionTarget: 'detached_run' } }, context))
            .toMatchObject({ ok: true, result: { status: 'applied' } });
    });
    expect(await read()).toMatchObject({ name: 'Agent notice', settings: { description: 'Authored together',
        projectTarget: { directory: '/other' }, executionTarget: 'detached_run' } });
    const transferred = hook.getCurrent().openInEditor();
    expect(transferred && readWorkflowDefinitionDraftSeed(transferred.params.definitionDraftSeedId, home.lifetime.scope))
        .toMatchObject({ description: 'Authored together', project: { directory: '/other' }, executionTarget: 'detached_run' });
    await act(async () => {
        expect(await executor.execute('workflow.authoring.draft.edit', { ...address, expectedDraftRevision: initial.draftRevision,
            ops: [{ kind: 'rename', name: 'Stale overwrite' }] }, context))
            .toMatchObject({ ok: true, result: { status: 'refused', reason: 'stale_draft_revision' } });
    });
    await act(async () => { await executor.execute('workflow.authoring.draft.undo', address, context); });
    expect(await read()).toMatchObject({ name: initial.name, settings: { description: '', projectTarget: { directory: '/repo' }, executionTarget: 'session' } });
    await act(async () => { await executor.execute('workflow.authoring.draft.redo', address, context); });
    home.refuseChild('workflow.definition.create');
    await act(async () => {
        expect(await save()).toMatchObject({ execution: { ok: true, result: { status: 'refused', reason: 'action_disabled' } } });
    });
    expect(home.children.map(child => child.actionId)).toEqual(['workflow.definition.create']);
    expect(home.creates).toHaveLength(0);
    home.refuseChild(undefined);
    await act(async () => {
        expect(await save()).toMatchObject({ execution: { ok: true, result: { status: 'applied' } } });
    });
    expect(home.children.map(child => child.actionId))
        .toEqual(['workflow.definition.create', 'workflow.definition.create', 'workflow.trigger.add']);
    const saved = await getWorkflowDefinition({ definitionId: hook.getCurrent().saved!.definitionId, accountLifetime: home.lifetime });
    expect(saved.metadata).toMatchObject({ title: 'Agent notice', description: 'Authored together' });
    expect(home.automations.creates).toHaveLength(1);
    expect(closed).toBe(true);
    closed = false;
    const latest = await read();
    await act(async () => {
        await executor.execute('workflow.authoring.draft.edit', { ...address, expectedDraftRevision: latest.draftRevision,
            ops: [{ kind: 'rename', name: 'Unsaved later edit' }] }, context);
        expect(await executor.execute('workflow.authoring.draft.discard', address,
            { surface: 'ui', serverId: home.lifetime.scope.serverId, expectedAccountId: home.lifetime.scope.accountId }))
            .toMatchObject({ ok: true, result: { status: 'applied' } });
    });
    expect(closed).toBe(true);
});

it('authors the mounted sentence through Actions without upgrading a refused trigger child to UI', async () => {
    const home = await sourceHome();
    const { hook, save } = await mountAgentSentence(home);
    home.refuseChild('workflow.trigger.add');
    await act(async () => {
        expect(await save()).toMatchObject({ execution: { ok: true, result: { status: 'refused', reason: 'action_disabled' } } });
    });
    expect(home.children.map(child => child.actionId)).toEqual(['workflow.definition.create', 'workflow.trigger.add']);
    expect(home.creates).toHaveLength(1);
    expect(home.automations.creates).toHaveLength(0);
    expect(hook.getCurrent().failed).not.toBeNull();
    expect(hook.getCurrent().triggers.dirty).toBe(true);
});

it('opens both conditional Sentence branches in their existing cards and retains their edits', async () => {
    const home = await sourceHome();
    const { WorkflowDefinitionV1Schema } = await import('@happier-dev/protocol/workflows/workflowV1');
    const { WorkflowDraftGetResultV1Schema } = await import('@happier-dev/protocol/actions/workflowAuthoringAction');
    const { WorkflowSentenceBuilder } = await import('../sentence/WorkflowSentenceBuilder');
    const { WorkflowActionBlockEditor } = await import('../editor/WorkflowActionBlockEditor');
    const when = { kind: 'exists', value: { kind: 'literal', value: true } } as const;
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'if', id: 'gate',
        when,
        then: [{ ...message, id: 'then-message' }],
        otherwise: [{ ...message, id: 'otherwise-message' }],
    }] });
    const restorePopover = withPopoverWebGlobals();
    try {
        const screen = await renderScreen(<WorkflowSentenceBuilder anchorRef={createRef<View>()}
            intent={{ name: 'Conditional notice', definition, trigger }} accountLifetime={home.lifetime} onRequestClose={() => {}} />, {
            createNodeMock: element => element.type === 'View' ? {
                addEventListener() {}, removeEventListener() {}, measureInWindow: callback => callback(0, 0, 300, 40),
            } satisfies Pick<View, 'measureInWindow'> & Pick<EventTarget, 'addEventListener' | 'removeEventListener'> : null,
        });
        try {
            const read = async () => {
                const result = await createDefaultActionExecutor().execute('workflow.authoring.draft.get',
                    { scope: home.lifetime.scope }, { surface: 'ui', authority: 'present_user' });
                expect(result.ok).toBe(true);
                if (!result.ok) throw new Error('Expected the mounted conditional draft');
                const parsed = WorkflowDraftGetResultV1Schema.parse(result.result);
                if (parsed.status !== 'available' || parsed.drafts.length !== 1) throw new Error('Expected one mounted draft');
                return WorkflowDefinitionV1Schema.parse(parsed.drafts[0]!.definition);
            };
            for (const [id, text] of [['then-message', 'Then branch edited'], ['otherwise-message', 'Otherwise branch edited']] as const) {
                await screen.pressByTestIdAsync(`workflow-builder-sentence-step:${id}`);
                const selected = screen.findAllByType(WorkflowActionBlockEditor).filter(node => node.props.selected);
                expect(selected.map(node => node.props.block.id)).toEqual([id]);
                expect(screen.findHostByTestId(`workflow-builder-action-${id}-card`)).not.toBeNull();
                await act(async () => screen.changeTextByTestId(`workflow-builder-action-${id}-field-message-text`, text));
            }
            await screen.pressByTestIdAsync('workflow-builder-sentence-step:then-message');
            expect(screen.findAllByType(WorkflowActionBlockEditor).filter(node => node.props.selected)
                .map(node => node.props.block.id)).toEqual(['then-message']);
            const retained = await read();
            expect(retained).toMatchObject({ blocks: [{ kind: 'if', id: 'gate', when,
                then: [{ id: 'then-message', input: { message: { kind: 'literal', value: 'Then branch edited' } } }],
                otherwise: [{ id: 'otherwise-message', input: { message: { kind: 'literal', value: 'Otherwise branch edited' } } }],
            }] });
        } finally {
            await screen.unmount();
        }
    } finally {
        restorePopover();
    }
});

it('hands an agent-cleared Project to the full editor without reviving the source place', async () => {
    const home = await sourceHome();
    const project = { machineId: 'machine-a', directory: '/repo' };
    const hook = await renderHook(() => authoring.useWorkflowSentenceDraft({ name: 'Notify', step: message, trigger, project }, home.lifetime));
    await act(async () => {
        expect(await hook.getCurrent().draftActions.execute('workflow.authoring.draft.edit', { scope: home.lifetime.scope,
            draftId: hook.getCurrent().draftStore.get().draftId, expectedDraftRevision: 0, settings: { projectTarget: null } }))
            .toMatchObject({ status: 'applied' });
    });
    const entry = hook.getCurrent().openInEditor();
    expect(entry && readWorkflowDefinitionDraftSeed(entry.params.definitionDraftSeedId, home.lifetime.scope)).not.toHaveProperty('project');
    await act(async () => { hook.getCurrent().history.undo(); });
    expect(hook.getCurrent().project).toEqual(project);
});

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

async function sourceHome(disabledAction?: typeof WORKFLOW_AUTHORING_ACTION_ID['draftSave' | 'draftDiscard']) {
    disposeLoader = await installRealActionExecutorModuleLoader();
    const accountId = 'sentence-author';
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: 'plain' });
    const automations = createWorkflowAutomationHttpBoundary();
    const creates: unknown[] = [];
    const requests: string[] = [];
    const children: SentenceChild[] = [];
    let refusedChild: SentenceChild['actionId'] | undefined;
    let beforeCreate: (() => Promise<Response | undefined>) | undefined;
    const restored = await restoreServerAccountForTest({ serverUrl: 'https://sentence-authoring.test', accountId,
        serverIdentityId: 'srv_sentence-authoring',
        configureSocket: socket => {
            configureConnectedServerSocketBoundary(socket);
            const emitWithAck = socket.emitWithAck.bind(socket);
            socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
            socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, raw: unknown) => {
                if (event !== SOCKET_RPC_EVENTS.CALL) return emitWithAck(event, raw);
                if (typeof raw !== 'object' || raw === null || !('method' in raw)
                    || raw.method !== `machine-a:${RPC_METHODS.UI_ACTION_CHILD_EXECUTE}` || !('params' in raw)) {
                    throw new Error('Unexpected mounted Sentence Machine RPC');
                }
                const child = UiActionChildExecuteRequestV1Schema.parse(raw.params);
                expect(child).toMatchObject({ parentRequestId: sentenceSaveRequestId, sessionId: agentCaller.sessionId });
                children.push(child);
                // This fixture is the daemon side of the real reverse RPC. It makes
                // the child decision before letting the accepted write reach the Home.
                const execution = child.actionId === refusedChild
                    ? { ok: false, errorCode: 'action_disabled', error: 'action_disabled' }
                    : await createDefaultActionExecutor().execute(child.actionId, child.input,
                        { surface: 'ui', authority: 'present_user', defaultSessionId: agentCaller.sessionId });
                return { ok: true, result: { v: 1, execution } };
            });
        },
        request: async (input, init) => {
            const url = new URL(String(input));
            requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (disabledAction !== undefined && url.pathname === '/v2/account/settings') {
                return Response.json(AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {
                    actionsSettingsV1: { v: 1, actions: { [disabledAction]: { enabled: false } } },
                } }, version: 1 }));
            }
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            const machine = createPlainMachineReadHttpResponseFixture(url.pathname, init, accountId);
            if (machine) return machine;
            if (url.pathname === '/v2/sessions/lifetime-session') return Response.json(createPlainSessionByIdResponseFixture(
                createSessionFixture({ id: 'lifetime-session', active: false, metadata: {
                    machineId: 'machine-a', path: '/repo', host: 'test',
                } })));
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
    if (disabledAction !== undefined) {
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        await sync.refreshAccountSettingsFromServer(1, lifetime.scope);
    }
    return { creates, requests, automations, lifetime, children,
        refuseChild: (actionId: SentenceChild['actionId'] | undefined) => { refusedChild = actionId; },
        interceptCreate: (intercept: typeof beforeCreate) => { beforeCreate = intercept; } };
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

it('saves a Session-lifetime sentence without a Project and carries that lifetime into the full editor', async () => {
    const home = await sourceHome();
    const lifetimeSession = { sessionId: 'lifetime-session' };
    const hook = await renderHook(() => authoring.useWorkflowSentenceDraft({ name: 'Session schedule', step: message,
        trigger, lifetimeSession }, home.lifetime));
    const entry = hook.getCurrent().openInEditor();
    if (!entry) throw new Error('Expected the ordinary editor entry');
    expect(readWorkflowDefinitionDraftSeed(entry.params.definitionDraftSeedId, home.lifetime.scope))
        .toMatchObject({ lifetimeSession });
    await act(async () => { expect(await hook.getCurrent().save(), JSON.stringify(home.requests)).toEqual({ status: 'applied' }); });
    expect(home.automations.creates).toHaveLength(1);
    expect(home.automations.creates[0]).toMatchObject({ scopeSessionId: lifetimeSession.sessionId });
    const saved = await getWorkflowDefinition({ definitionId: hook.getCurrent().saved!.definitionId, accountLifetime: home.lifetime });
    expect(saved.definition.blocks).toEqual([message]);
    await act(async () => { expect(await hook.getCurrent().save()).toEqual({ status: 'unchanged' }); });
    expect(home.automations.creates).toHaveLength(1);
});

// Reviews U7: deliberate new all-Session habits belong to the Account; retained habits keep their lifetime.
it.each(['session', 'project', 'machine', 'any', 'chooseAny', 'chooseSession'] as const)('saves the shared sentence with its authored %s lifetime', async kind => {
    const home = await sourceHome();
    const subject = { kind: 'session', serverId: resolvePortableServerIdentityForRoutingId(home.lifetime.scope.serverId)!, sessionId: 'lifetime-session' } as const;
    const startContext = { session: { subject } };
    if (kind === 'session') {
        const other = await renderHook(() => authoring.useWorkflowSentenceDraft({ name: 'Another Session workflow', step: message,
            trigger, lifetimeSession: { sessionId: subject.sessionId } }, home.lifetime));
        await act(async () => { expect(await other.getCurrent().save()).toEqual({ status: 'applied' }); });
        await other.unmount();
    }
    const watched = kind === 'session' || kind === 'chooseSession' ? subject : kind === 'project'
        ? { kind, serverId: subject.serverId, projectKey: 'project-a' } as const : kind === 'machine'
            ? { kind, serverId: subject.serverId, machineId: 'machine-a' } as const : undefined;
    const accountHabit = kind === 'any' || kind === 'chooseAny';
    const intent = createSessionWorkflowSentenceIntent({ name: 'Session automation', session: startContext.session,
        ...(accountHabit || kind === 'chooseSession' ? { project: { machineId: 'machine-a', directory: '/repo' } } : {}) },
        kind === 'session' || kind === 'chooseAny' ? undefined : { subject: kind === 'chooseSession' ? undefined : watched });
    if (intent === null) throw new Error('Expected Session intake');
    const hook = await renderHook(() => authoring.useWorkflowSentenceDraft({ ...intent, step: message }, home.lifetime));
    expect(hook.getCurrent().triggers.draft.adds).toMatchObject([{ trigger: { kind: 'sessionLifecycle' } }]);
    if (kind === 'chooseAny' || kind === 'chooseSession') {
        const add = hook.getCurrent().triggers.draft.adds[0]!;
        if (add.trigger.kind !== 'sessionLifecycle' || !('events' in add.trigger) || 'triggerDefinitionEnvelope' in add.trigger) throw new Error('Expected lifecycle habit');
        const { subject: _subject, ...allSessions } = add.trigger;
        await act(async () => hook.getCurrent().triggers.setDraft(editWorkflowTriggerDraft(hook.getCurrent().triggers.draft,
            { kind: 'add', clientId: add.clientId, trigger: kind === 'chooseSession' ? { ...allSessions, subject } : allSessions })));
    }
    const initialEntry = hook.getCurrent().openInEditor();
    if (!initialEntry) throw new Error('Expected the unsaved editor entry');
    const initialSeed = readWorkflowDefinitionDraftSeed(initialEntry.params.definitionDraftSeedId, home.lifetime.scope);
    if (accountHabit) expect(initialSeed).not.toHaveProperty('lifetimeSession');
    else expect(initialSeed).toHaveProperty('lifetimeSession', { sessionId: subject.sessionId });
    await act(async () => { expect(await hook.getCurrent().save(), JSON.stringify(home.requests)).toEqual({ status: 'applied' }); });
    if (accountHabit) expect(home.automations.creates.at(-1)).toMatchObject({ scopeSessionId: null });
    else expect(home.automations.creates.at(-1)).toMatchObject({ scopeSessionId: subject.sessionId });
    await vi.waitFor(() => expect(hook.getCurrent().triggers.set?.triggers[0]?.kind).toBe('sessionLifecycle'));
    const savedTrigger = hook.getCurrent().triggers.set!.triggers[0];
    expect(savedTrigger).toMatchObject({ kind: 'sessionLifecycle', policy: { kind: 'everyMatch' } });
    if (watched === undefined) expect(savedTrigger).not.toHaveProperty('subject');
    else expect(savedTrigger).toHaveProperty('subject', watched);
    const entry = hook.getCurrent().openInEditor();
    const savedSeed = entry && readWorkflowDefinitionDraftSeed(entry.params.definitionDraftSeedId, home.lifetime.scope);
    expect(savedSeed).toMatchObject({ startContext,
        triggers: { rows: [{ trigger: { kind: 'sessionLifecycle', policy: { kind: 'everyMatch' } } }] } });
    if (accountHabit) expect(savedSeed).not.toHaveProperty('lifetimeSession');
    else expect(savedSeed).toHaveProperty('lifetimeSession', { sessionId: subject.sessionId });
});

it.each([false, true])('saves the exact Session turn or shows the owner refusal when stale=%s', async (stale) => {
    const home = await sourceHome();
    const subject = { kind: 'session', serverId: resolvePortableServerIdentityForRoutingId(home.lifetime.scope.serverId)!, sessionId: 'lifetime-session' } as const;
    const source = { name: 'This turn', session: { subject } };
    const exactTurnPrefill = { sourceSessionId: subject.sessionId, sourceServerId: home.lifetime.scope.serverId,
        sourceTurnId: 'turn-a', events: ['parentTurnCompleted'] as const };
    expect(createSessionWorkflowSentenceIntent(source, { exactTurnPrefill: { ...exactTurnPrefill, sourceSessionId: 'another-session' } })).toBeNull();
    expect(createSessionWorkflowSentenceIntent(source, { exactTurnPrefill: { ...exactTurnPrefill, sourceServerId: 'another-home' } })).toBeNull();
    expect(createSessionWorkflowSentenceIntent(source, { subject: undefined, exactTurnPrefill })).toBeNull();
    const intent = createSessionWorkflowSentenceIntent(source, { exactTurnPrefill });
    if (intent === null) throw new Error('Expected exact-turn intake');
    const definition = { version: 1, defaults: {}, inputs: [], blocks: [{ kind: 'wait', id: 'wait',
        document: { text: 'Acknowledge the QA trigger run.', references: [], attachments: [] } }] } satisfies NonNullable<Parameters<typeof authoring.useWorkflowSentenceDraft>[0]['definition']>;
    const hook = await renderHook(() => authoring.useWorkflowSentenceDraft({ ...intent, definition }, home.lifetime));
    // The editor's portable Workflow defaults to the Machine's Home folder. The watched Session is in /repo.
    await act(async () => hook.getCurrent().changeProject({ machineId: 'machine-a', directory: '~' }));
    const exactTrigger = { trigger: { subject, policy: { kind: 'currentTurn', sourceTurnId: 'turn-a' } } };
    expect(hook.getCurrent().triggers.draft.adds).toMatchObject([exactTrigger]);
    if (stale) home.automations.respondWith(method => method === 'POST'
        ? Response.json({ error: 'sourceTurnNotInProgress' }, { status: 400 })
        : undefined);
    await act(async () => {
        expect(await hook.getCurrent().save()).toMatchObject({ status: stale ? 'refused' : 'applied' });
    });
    expect(home.automations.creates).toHaveLength(1);
    expect(home.automations.creates[0]).toMatchObject({ scopeSessionId: subject.sessionId,
        executionRecipe: { workflow: { t: 'plain', v: { workspace: { directory: '/repo' } } } } });
    if (stale) {
        expect(home.automations.rows.size).toBe(0);
        expect(hook.getCurrent().triggers.draft.adds).toMatchObject([exactTrigger]);
        expect(hook.getCurrent().failed).toContain(t('automations.exactTurn.staleBody'));
        return;
    }
    await vi.waitFor(() => expect(hook.getCurrent().triggers.set?.triggers[0]).toMatchObject({
        subject, policy: { kind: 'currentTurn', sourceTurnId: 'turn-a' },
    }));
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
        .toMatchObject({ draft: { blocks: [edited] }, triggers: { rows: [{ trigger: later }] } });
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

it('carries unresolved native Event intent through sentence history and the full editor without reading the watched Machine', async () => {
    const home = await sourceHome();
    const nativeEvent = { key: 'presence', kind: 'machine', machineId: 'offline-machine', event: 'offline',
        sourceRevision: 999_999, occurredAt: 10, coverage: 'live' } as const;
    const hook = await renderHook(() => authoring.useWorkflowSentenceDraft({ name: 'Offline', step: message, nativeEvent }, home.lifetime));
    expect(hook.getCurrent().triggers.incomplete.pending).toMatchObject([{ nativeEvent, when: { kind: 'pluginEvent', value: null } }]);
    expect(hook.getCurrent().triggers.incomplete.pending[0]?.when).not.toHaveProperty('eventRef');
    const edited = { ...message, input: { ...message.input, message: { kind: 'literal' as const, value: 'Edited offline notice' } } };
    await act(async () => hook.getCurrent().changeStep(edited));
    await act(async () => hook.getCurrent().history.undo());
    expect(hook.getCurrent().draftStore.get().blocks).toEqual([message]);
    await act(async () => hook.getCurrent().history.redo());
    const project = { machineId: 'controller', directory: '/repo' };
    await act(async () => hook.getCurrent().changeProject(project));
    const entry = hook.getCurrent().openInEditor();
    if (!entry) throw new Error('Expected the ordinary full editor entry');
    expect(readWorkflowDefinitionDraftSeed(entry.params.definitionDraftSeedId, home.lifetime.scope))
        .toMatchObject({ project, draft: { blocks: [edited] }, incompleteTriggers: { pending: [{ nativeEvent }] } });
    expect(home.requests.some(request => request.includes('offline-machine'))).toBe(false);
    expect(home.creates).toEqual([]);
    expect(home.automations.creates).toEqual([]);
});

it('does not turn an unresolved native Events seed into a manual workflow on Save', async () => {
    const home = await sourceHome();
    // QA-C r14-events-current-automate: a native Machine offline occurrence remains Set up.
    const nativeEvent = { key: 'presence', kind: 'machine', machineId: 'offline-machine', event: 'offline',
        sourceRevision: 999_999, occurredAt: 10, coverage: 'live' } as const;
    const hook = await renderHook(() => authoring.useWorkflowSentenceDraft({ name: 'A Machine went offline', step: message, nativeEvent }, home.lifetime));
    await act(async () => { expect(await hook.getCurrent().save()).toEqual({ status: 'refused', reason: 'invalid_workflow' }); });
    expect(home.creates).toEqual([]);
    expect(home.automations.creates).toEqual([]);
    expect(hook.getCurrent().saved).toBeNull();
    const entry = hook.getCurrent().openInEditor();
    if (!entry) throw new Error('Expected the ordinary full editor entry');
    expect(readWorkflowDefinitionDraftSeed(entry.params.definitionDraftSeedId, home.lifetime.scope))
        .toMatchObject({ draft: { blocks: [message] }, incompleteTriggers: { pending: [{ nativeEvent }] } });
    await act(async () => hook.getCurrent().triggers.updateIncomplete(() => ({ pending: [],
        edits: { 'saved:offline-watch': { kind: 'pluginEvent', value: null } } })));
    await act(async () => { expect(await hook.getCurrent().save()).toEqual({ status: 'refused', reason: 'invalid_workflow' }); });
    expect(home.creates).toEqual([]);
    // Deliberately removing the unfinished trigger is how this draft becomes manual.
    await act(async () => hook.getCurrent().triggers.updateIncomplete(() => ({ pending: [], edits: {} })));
    await act(async () => { expect(await hook.getCurrent().save()).toEqual({ status: 'applied' }); });
    expect(home.creates).toHaveLength(1);
    expect(home.automations.creates).toEqual([]);
    await act(async () => hook.getCurrent().triggers.updateIncomplete(() => ({ edits: {},
        pending: [{ clientId: 'another-offline', nativeEvent, when: { kind: 'pluginEvent', value: null } }] })));
    await act(async () => { expect(await hook.getCurrent().save()).toEqual({ status: 'refused', reason: 'invalid_workflow' }); });
    expect(home.creates).toHaveLength(1);
    const resumed = await renderHook(() => authoring.useWorkflowSentenceDraft({ name: 'A Machine went offline',
        step: { ...message, name: 'Tell the team' }, nativeEvent,
        project: { machineId: 'controller', directory: '/repo' } }, home.lifetime));
    const { AutomationTriggerDefinitionInputSchema } = await import('@happier-dev/protocol/automations/automationTriggerDefinition');
    const configured = AutomationTriggerDefinitionInputSchema.parse({ kind: 'pluginEvent', enabled: true,
        eventRef: { pluginId: 'acme.presence', localId: 'offline' }, sourceInstanceId: 'offline-machine',
        sourceContractVersion: 1, sourceConfig: {}, displayLabel: 'When this Machine goes offline', filter: null,
        maximumObservationAgeMs: null, observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
            machineId: 'controller', pluginId: 'acme.presence', materializationId: 'presence-1',
        } } });
    await act(async () => {
        resumed.getCurrent().triggers.updateIncomplete(() => ({ pending: [], edits: {} }));
        resumed.getCurrent().triggers.setDraft(editWorkflowTriggerDraft(resumed.getCurrent().triggers.draft,
            { kind: 'add', clientId: 'configured-offline', trigger: configured }));
    });
    const derivedName = resumed.getCurrent().draftStore.get().name;
    expect(derivedName).toBe('When this Machine goes offline → tell the team');
    await act(async () => { expect(await resumed.getCurrent().save()).toEqual({ status: 'applied' }); });
    const persisted = await getWorkflowDefinition({ definitionId: resumed.getCurrent().saved!.definitionId, accountLifetime: home.lifetime });
    expect(persisted.metadata.title).toBe(derivedName);
    expect(home.automations.creates).toHaveLength(1);
});
