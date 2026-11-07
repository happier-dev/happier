import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, onTestFailed, vi } from 'vitest';
import { createSessionFixture, standardCleanup } from '@/dev/testkit';
import { createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { BotTemplateDraftV1Schema, projectBotTemplateArtifactHeaderV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { deriveActionChildRequestIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { BUILT_IN_ROLES_V1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';

installSettingsViewCommonModuleMocks({ storage: 'real', text: async () => vi.importActual<typeof import('@/text')>('@/text') });
// Vitest replaces Metro's deferred loader; Action admission, approval custody and dispatch remain real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
const { storage } = await import('@/sync/domains/state/storage');
const { useOpenBotTemplate, readSessionTemplateDraftRef } = await import('@/components/sessions/bots/templates/openBotTemplate');
const { useOptionalCurrentUiContextReader, usePublishCurrentUiContext } = await import('./CurrentUiContextProvider');
const { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands, useCurrentUiContextLocalCommands } = await import('./CurrentUiContextCommands');
const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { t } = await import('@/text');
const { Pressable } = await import('react-native');

afterEach(async () => {
    await standardCleanup();
    vi.unstubAllGlobals();
    await homes.reset();
});

it.each(['agent', 'ui'] as const)('preserves %s authority with operation confirmation flags for the exact child', async surface => {
    vi.stubGlobal('crypto', globalThis.crypto ?? webcrypto);
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(homes.request);
    await loadSyncSingletonForTests();
    const serverUrl = 'https://mounted-consent.test';
    const serverId = await homes.addHome({ name: 'Mounted consent', serverUrl, serverIdentityId: 'srv_mounted_consent',
        accountId: 'mounted_owner', currentAccount: true });
    await homes.requireUiApproval(serverId, 'roles.create');
    await homes.requireActionApproval(serverId, 'roles.create', 'agent');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer((await TokenStorage.getCredentialsForServerUrl(serverUrl))!);
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    const callerSession = createSessionFixture({ id: 'consent-caller', serverId });
    homes.answer(serverId, `/v2/sessions/${callerSession.id}`, { body: createPlainSessionByIdResponseFixture(callerSession) });
    const input = { roleId: 'mounted-child-role', role: BUILT_IN_ROLES_V1.builder };
    const childRequestId = deriveActionChildRequestIdV1({ parentRequestId: 'bound-consent-parent',
        parentActionId: 'ui.current_context.command.invoke', childActionId: 'roles.create', position: 0 });
    const controller = new AbortController();
    let reader: ReturnType<typeof useOptionalCurrentUiContextReader> = null;
    let engine: ReturnType<typeof useMountedActionExecution> | undefined;
    function Command() {
        reader = useOptionalCurrentUiContextReader();
        const mounted = useMountedActionExecution(serverId);
        engine = mounted;
        useCurrentUiContextLocalCommands([{ key: 'create-role', title: 'Create role', invoke: async (_input, _context, invocation) => {
            const result = await invocation.execute(mounted, 'roles.create', input, { signal: controller.signal, confirmed: true,
                presentUserConfirmation: { actionId: 'roles.create', accountId: 'mounted_owner', serverId: 'srv_mounted_consent',
                    requestId: childRequestId, inputDigest: computeActionInputApprovalDigestV1('roles.create', input), target: null } });
            return result.ok ? { ok: true } : { ok: false, code: 'denied', errorCode: result.errorCode };
        } }]);
        return null;
    }
    function Publication() {
        const commands = useCurrentUiContextComposedCommands();
        usePublishCurrentUiContext(React.useMemo(() => ({ commands }), [commands]));
        return null;
    }
    const screen = await renderMountedCurrentUiContext(<CurrentUiContextCommandsProvider authority={captureActiveServerAccountScopeLifetime()}>
        <Publication /><Command />
    </CurrentUiContextCommandsProvider>, { withModalProvider: true });
    const command = reader!.readCurrentUiContext()!.commands.find(row => row.title === 'Create role')!;
    const executor = createDefaultActionExecutor();
    let outcome: Awaited<ReturnType<typeof executor.execute>> | undefined;
    let pending: ReturnType<typeof executor.execute> | undefined;
    await act(async () => { pending = executor.execute('ui.current_context.command.invoke', { commandId: command.id }, {
        serverId, surface, actionRequestId: 'bound-consent-parent', ...(surface === 'agent' ? {
            authority: 'account_automation' as const, defaultSessionId: callerSession.id,
            actionCaller: { kind: 'session' as const, sessionId: callerSession.id, starterDepth: 0, turnDepth: 0 },
        } : {}),
    }).then(result => { outcome = result; return result; }); });
    try {
        await waitForHomeGovernance(() => expect(homes.artifacts(serverId).list().length > 0 || outcome !== undefined).toBe(true));
        if (surface === 'agent') {
            expect(homes.artifacts(serverId).readPlainBody(input.roleId), JSON.stringify(outcome)).toBeNull();
            const row = homes.artifacts(serverId).list()[0];
            expect(row, JSON.stringify(outcome)).toBeDefined();
            expect(ApprovalRequestV2Schema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(row!.id)!)))
                .toMatchObject({ status: 'open', requestedSurface: surface, executionOriginV1: { requestId: childRequestId } });
        } else {
            expect(homes.artifacts(serverId).readPlainBody(input.roleId), JSON.stringify(outcome)).not.toBeNull();
        }
    } finally {
        controller.abort();
        await pending;
    }
    await act(async () => {
        expect(await engine!.execute('roles.create', { ...input, roleId: 'actual-touch-role' }, { confirmed: true })).toMatchObject({ ok: true });
    });
    expect(homes.artifacts(serverId).readPlainBody('actual-touch-role')).not.toBeNull();
    await screen.unmount();
});

it('keeps an agent caller on the legacy Give a copy command and refuses its own approval despite explicit Allow', async () => {
    let phase = 'restore-account';
    let invocationOutcome: Awaited<ReturnType<ReturnType<typeof createDefaultActionExecutor>['execute']>> | undefined;
    onTestFailed(() => console.error('legacy approval boundary', JSON.stringify({ phase, invocationOutcome,
        requests: homes.requests.map(request => ({ path: request.path, method: request.method })) })));
    vi.stubGlobal('crypto', globalThis.crypto ?? webcrypto);
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(homes.request);
    await loadSyncSingletonForTests();
    const serverId = await homes.addHome({ name: 'Mounted commands Home', serverUrl: 'https://mounted-approval.test',
        serverIdentityId: 'srv_mounted_approval', accountId: 'mounted_owner', currentAccount: true, botsEnabled: true });
    await homes.requireUiApproval(serverId, 'template.open');
    await homes.requireActionApproval(serverId, 'template.open', 'agent');
    await homes.setActionPolicy(serverId, 'approval.request.decide', 'agent', 'allowed');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer((await TokenStorage.getCredentialsForServerUrl('https://mounted-approval.test'))!);
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    const artifactId = '20fe6b6d-2a3e-4fdb-ae3d-00c0e7cd664d';
    const session = createSessionFixture({ id: 'template-source', serverId, metadata: {
        path: '/garden', host: 'author', bot: { kind: 'bot' }, work: { templateDraftRef: { serverId, artifactId } },
    } });
    expect(readSessionTemplateDraftRef(session)).toEqual({ serverId, artifactId });
    const callerSession = createSessionFixture({ id: 'caller-session', serverId });
    homes.answer(serverId, `/v2/sessions/${callerSession.id}`, { body: createPlainSessionByIdResponseFixture(callerSession) });
    homes.answer(serverId, `/v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
    storage.getState().applySessions([session]);
    const draft = BotTemplateDraftV1Schema.parse({ v: 1, state: 'draft', sourceSessionRef: { serverId, sessionId: session.id },
        releaseArtifactId: '5bdb3f40-e1b4-4e6b-b079-3ae53c6f1db4',
        content: { v: 1, identity: { name: 'Garden', description: 'Plant care' }, instructions: { markdown: 'Care for the herbs' },
            memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } },
        candidates: { memoryRules: [], skills: [] } });
    const header = projectBotTemplateArtifactHeaderV1(draft);
    homes.artifacts(serverId).replaceStoredRow(createPlainArtifactHttpFixture({ id: artifactId, isDecrypted: true,
        title: header.title, header, body: JSON.stringify(draft), headerVersion: 1, bodyVersion: 1,
        seq: 1, createdAt: 1, updatedAt: 1 }, 'mounted_owner'));
    let reader: ReturnType<typeof useOptionalCurrentUiContextReader> = null;
    function LegacyCommand() {
        reader = useOptionalCurrentUiContextReader();
        const open = useOpenBotTemplate(session, serverId, true);
        return <Pressable testID="legacy-give-copy" onPress={() => { void open?.(); }} />;
    }
    function Publication() {
        const commands = useCurrentUiContextComposedCommands();
        usePublishCurrentUiContext(React.useMemo(() => ({ commands }), [commands]));
        return null;
    }
    const screen = await renderMountedCurrentUiContext(<CurrentUiContextCommandsProvider authority={captureActiveServerAccountScopeLifetime()}>
        <Publication /><LegacyCommand />
    </CurrentUiContextCommandsProvider>, { withModalProvider: true });
    phase = 'publish-legacy-command';
    await waitForHomeGovernance(() => expect(reader?.readCurrentUiContext()?.commands.some(command => command.title === t('botTemplates.giveCopy'))).toBe(true));
    const command = reader!.readCurrentUiContext()!.commands.find(candidate => candidate.title === t('botTemplates.giveCopy'))!;
    const agentController = new AbortController();
    const caller: ActionExecutorContext = { serverId, surface: 'agent', authority: 'account_automation', defaultSessionId: 'caller-session',
        signal: agentController.signal,
        actionRequestId: 'legacy-give-copy-agent',
        actionCaller: { kind: 'session', sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 } };
    const executor = createDefaultActionExecutor();
    let invocation: ReturnType<typeof executor.execute> | undefined;
    phase = 'invoke-agent-command';
    await act(async () => { invocation = executor.execute('ui.current_context.command.invoke', { commandId: command.id }, caller)
        .then(outcome => { invocationOutcome = outcome; return outcome; }); });
    let approvalId = '';
    phase = 'persist-agent-request';
    await waitForHomeGovernance(() => {
        expect(homes.artifacts(serverId).list().some(row => row.id !== artifactId) || invocationOutcome !== undefined).toBe(true);
    });
    const approval = homes.artifacts(serverId).list().find(row => row.id !== artifactId);
    expect(approval, JSON.stringify(invocationOutcome)).toBeDefined();
    approvalId = approval!.id;
    const readApproval = () => ApprovalRequestV2Schema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(approvalId)!));
    expect.soft(readApproval()).toMatchObject({ requestedSurface: 'agent', createdBy: { surface: 'agent', sessionId: 'caller-session' },
        executionOriginV1: { surface: 'agent', authority: 'account_automation', caller: { kind: 'session', sessionId: 'caller-session' },
            requestId: deriveActionChildRequestIdV1({ parentRequestId: 'legacy-give-copy-agent',
                parentActionId: 'ui.current_context.command.invoke', childActionId: 'template.open', position: 0 }) } });
    phase = 'refuse-self-approval';
    await act(async () => {
        expect(await executor.execute('approval.request.decide', { artifactId: approvalId, decision: 'approve' }, caller))
            .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    });
    expect(readApproval().status).toBe('open');
    // This host-private fixture proves the Session-described caller's origin, not
    // signed Session replay custody. Its real caller signal still cancels the waiter.
    phase = 'cancel-agent-invocation';
    await act(async () => { agentController.abort(); });
    expect(await invocation).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    const agentApprovalId = approvalId;
    phase = 'touch-open';
    await screen.pressByTestIdAsync('legacy-give-copy');
    await waitForHomeGovernance(() => {
        const approval = homes.artifacts(serverId).list().find(row => row.id !== artifactId && row.id !== agentApprovalId);
        expect(approval).toBeDefined();
        approvalId = approval!.id;
    });
    expect(readApproval()).toMatchObject({ requestedSurface: 'ui', createdBy: { surface: 'system' },
        executionOriginV1: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' } } });
    // Explicit Allow still permits delegation for a request made by an actual touch.
    await act(async () => {
        expect(await executor.execute('approval.request.decide', { artifactId: approvalId, decision: 'approve' },
            { ...caller, signal: undefined, actionRequestId: 'delegate-touch-created-request' }))
            .toMatchObject({ ok: true });
    });
    await waitForHomeGovernance(() => expect(readApproval().status).toBe('executed'));
    await screen.unmount();
});
