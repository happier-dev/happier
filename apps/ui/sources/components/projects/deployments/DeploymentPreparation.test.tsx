// @vitest-environment jsdom
import * as React from 'react';
import { t } from '@/text';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, standardCleanup, waitForTestEvent, createPlainProjectAccountRowListFixture } from '@/dev/testkit';
import { renderAccountScreen } from '@/dev/testkit/render/renderAccountScreen';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { ScmStatusSnapshotResponseSchema, createScmCapabilities } from '@happier-dev/protocol/scm';
import { DeploymentPrepareInputV1Schema, type DeploymentPrepareResultV1 } from '@happier-dev/protocol/deployments/deploymentPreparationV1';
import { createDeploymentReadControllerV1 } from '@happier-dev/deployments';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createHydratedPlainMachineFixture, createReadyMachineAgentInventoryFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { resolveSessionSpawnNewResultFailureMessage } from '@/sync/ops/actions/sessionSpawnFailurePresentation';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
const router = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => router.module);
const scm = vi.hoisted(() => ({ reply: undefined as unknown, inventory: undefined as unknown, capabilities: undefined as unknown }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
  (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(async request => {
    if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
      return { protocolVersion: 1, projection: scm.inventory };
    if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return scm.capabilities;
    if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return scm.reply;
    throw new Error(`Unexpected preparation Machine RPC: ${request.method}`);
  }));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { DeploymentEnvironmentAgentActions } = await import('./DeploymentEnvironmentAgentActions');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { ModalProvider } = await import('@/modal');
const { ProjectDeploymentsView } = await import('./ProjectDeploymentsBody');
const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
const { createDeploymentActions } = await import('./deploymentActions');
const { buildScopedSessionRouteHref } = await import('@/hooks/session/sessionRouteServerScope');
const { SessionServerStartDraftComposerModal } = await import('@/components/sessions/new/SessionServerStartDraftComposerModal');
const { SessionAuthoringControls } = await import('@/components/sessions/authoring/controls/SessionAuthoringControls');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { storage } = await import('@/sync/domains/state/storage');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const selectedRecipe = {
  agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
  connectedServices: { v: 2, bindingsByServiceId: {
    'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: '97bd5614-8970-4068-87f2-1447de69d604' },
  } },
};
// Load the actual lazy Action graph during collection, outside the interaction's deadline.
await import('@/sync/ops/actions/defaultActionExecutor');

async function fixture() {
  await homes.reset();
  router.resetParams(); router.spies.push.mockClear();
  const serverId = await homes.addHome({ name: 'Preparation', serverUrl: 'https://preparation-entry.test',
    accountId: 'owner', serverIdentityId: `srv_${'7'.repeat(32)}`, currentAccount: true });
  const source = { id: 'project', revision: 3, name: 'App', defaultRef: 'preparation-ready-branch', audience: [], createdByAccountId: 'owner',
    repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'owner/app', visibility: 'private' }, protocol: 'https' } };
  homes.answer(serverId, '/v1/projects/sources/project', { body: { ok: true, source, canManage: true } });
  homes.answer(serverId, 'POST /v1/account/project-rows/list', { body: createPlainProjectAccountRowListFixture({
    workspaceRefs: [{ id: 'checkout', serverId, machineId: 'workspace-machine', rootPath: '/app', label: 'App checkout',
      createdAtMs: 1, source: { sourceId: 'project', revision: 3 } }] }) });
  scm.reply = ScmStatusSnapshotResponseSchema.parse({ success: true, snapshot: {
    projectKey: 'workspace-machine:/app', fetchedAt: 1,
    repo: { isRepo: true, rootPath: '/app', backendId: 'git', mode: '.git' }, capabilities: createScmCapabilities(),
    branch: { head: 'main', headOid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0, detached: false },
    hasConflicts: false, entries: [], totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0,
      includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
  } });
  const account = await captureLazyActionAccountContext(serverId);
  const inventory = createReadyMachineAgentInventoryFixture([
    { agentId: 'claude', title: 'Claude' },
    { agentId: 'codex', title: 'Codex' },
  ]);
  scm.inventory = inventory.projection;
  scm.capabilities = inventory.capabilities;
  storage.getState().applyMachines([createHydratedPlainMachineFixture({ id: 'workspace-machine', accountId: 'owner',
    machine: { active: true, activeAt: Date.now() } })], true, { sourceServerId: serverId });
  clearDaemonMergedProjectionCacheForTests();
  return { serverId, account };
}
async function waitReady(screen: Awaited<ReturnType<typeof renderAccountScreen>>) {
  await waitForTestEvent(screen.subscribe, () => {
    expect(screen.findByTestId('project-deployments.prepare.confirm')?.props.disabled).toBe(false);
  });
}

async function submitSessionRecipe(screen: Awaited<ReturnType<typeof renderAccountScreen>>) {
  await waitForTestEvent(screen.subscribe, () => {
    expect(screen.findAllByType(SessionAuthoringControls).length, screen.getTextContent()).toBeGreaterThan(0);
  });
  await act(async () => { screen.findAllByType(SessionAuthoringControls)[0]!.props.onChangeFields(selectedRecipe); });
  const submit = () => screen.findAllByType(RoundButton).find(button => button.props.title === t('newSession.recipeComposerSubmit'));
  await waitForTestEvent(screen.subscribe, () => { expect(submit()?.props.disabled).toBe(false); });
  await act(async () => { submit()!.props.onPress(); });
}


afterEach(async () => {
  const { Modal } = await import('@/modal');
  await act(async () => { Modal.hideAll(); });
  await standardCleanup();
});

describe('deployment preparation entry', () => {
  it('shows what Happier recognized in the chosen checkout before an agent is asked (lab f1prep)', async () => {
    const { serverId, account } = await fixture();
    const { DeploymentPreparationEntry } = await import('./DeploymentPreparation');
    const { readProjectManifestDocument } = await import('@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument');
    const { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } = await import('@happier-dev/protocol/actions/externalActionApi');
    const inspected: unknown[] = [];
    // The Action root discovers the checkout Machine's custody before it admits the read.
    const { createPlainMachineRowFixture } = await import('@/dev/testkit');
    const machine = createPlainMachineRowFixture({ id: 'workspace-machine', accountId: 'owner' });
    homes.answer(serverId, '/v1/machines', { body: [machine] });
    homes.answer(serverId, 'GET /v1/machines/workspace-machine', { body: { machine } });
    // The Home's Action route is the boundary; the UI's read, its Action admission and the sheet stay real.
    homes.answer(serverId, '/v1/actions/projects.inspect', { select: body => {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
      inspected.push(envelope.input);
      return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.inspect', requestId: envelope.requestId,
        execution: { ok: true, result: {
          definition: { basis: { kind: 'present', hash: 'a'.repeat(64) }, document: readProjectManifestDocument('{ "version": 1 }\n') },
          detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'partial', diagnostics: [],
            rootFiles: { dockerfile: 'present', compose: 'present' }, environmentExample: 'present', healthPath: '/healthz',
            applications: [{ file: 'package.json', framework: 'Next.js', runtime: { name: 'Node.js', version: '22' },
              build: null, start: null, port: 3000 }] },
          importCandidates: [] } } }) };
    } });
    const screen = await renderAccountScreen(<ModalProvider><DeploymentPreparationEntry
      lifetime={account.accountLifetime} projectSourceId="project" mode="prepare" /></ModalProvider>);
    try {
      await screen.pressByTestIdAsync('project-deployments.prepare.open');
      // Settles on what the read reported: recognized rows, nothing recognized, or a refused read.
      await waitForTestEvent(screen.subscribe, () => ['recognized.package.json', 'recognized.none', 'recognized.failed']
        .some(id => screen.findByTestId(`project-deployments.prepare.${id}`)), Boolean);
      expect(screen.findByTestId('project-deployments.prepare.recognized.package.json'), screen.getTextContent()).not.toBeNull();
      const text = screen.getTextContent();
      expect(text).toContain('Next.js');
      expect(text).toContain(t('projects.deployments.preparation.listensOn', { port: 3000 }));
      expect(text).toContain('/healthz');
      expect(screen.findByTestId('project-deployments.prepare.recognized.dockerfile')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.prepare.recognized.compose')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.prepare.recognized.environment-example')).not.toBeNull();
      // A partial read says so instead of reading as everything there is.
      expect(text).toContain(t('projects.deployments.preparation.recognizedPartial'));
      // The checkout the agent works in is the one read, once.
      expect(inspected).toHaveLength(1);
      expect(inspected[0]).toMatchObject({ workspace: { workspaceId: 'checkout', machineId: 'workspace-machine', rootPath: '/app' },
        read: { kind: 'applications' } });
    } finally { await screen.unmount(); account.dispose(); }
  });
  it('retains a refused child Session cause through real HTTP preparation and the existing disclosure', async () => {
    const { serverId, account } = await fixture();
    const { DeploymentPreparationEntry } = await import('./DeploymentPreparation');
    const child = SessionSpawnNewActionResultV1Schema.parse({ type: 'error', code: 'agent_signed_out',
      retryable: false, agentId: 'claude', launchError: { kind: 'launch_error', code: 'agent_signed_out',
        message: 'Private native authentication diagnostic',
        failureCause: { phase: 'authentication', failureReason: 'authentication_required' } } });
    if (child.type !== 'error' || !('launchError' in child) || !child.launchError) throw new Error('Expected a Session launch refusal');
    let requestId: string | undefined;
    await answerExternalActionAccountForHome(homes, serverId, { machineId: 'workspace-machine',
      actionId: 'deployments.prepare', tokenEpoch: 0,
      execute(_input, context) { requestId = context.requestId; return child; },
      failure: () => ({ errorCode: child.code, error: child.code, details: child }),
    });
    const screen = await renderAccountScreen(<ModalProvider><DeploymentPreparationEntry
      lifetime={account.accountLifetime} projectSourceId="project" mode="prepare" /></ModalProvider>);
    try {
      await screen.pressByTestIdAsync('project-deployments.prepare.open');
      await waitReady(screen);
      await screen.pressByTestIdAsync('project-deployments.prepare.confirm');
      await submitSessionRecipe(screen);
      await waitForTestEvent(screen.subscribe, () => {
        expect(screen.findByTestId('project-deployments.prepare.refused')).not.toBeNull();
      });
      expect(requestId).toBeTruthy();
      expect(screen.getTextContent()).toContain(resolveSessionSpawnNewResultFailureMessage(child));
      expect(screen.findByTestId('project-deployments.prepare.refused-details-code')).toBeNull();
      await screen.pressByTestIdAsync('project-deployments.prepare.refused-details-toggle');
      expect(screen.getTextContent()).toContain(child.code);
      expect(screen.getTextContent()).toContain(requestId);
      expect(screen.getTextContent()).not.toContain(child.launchError.message);
      expect(router.spies.push).not.toHaveBeenCalled();
    } finally { await screen.unmount(); account.dispose(); }
  });
  it('opens the canonical Session recipe before dispatch and cancels without creating a Session', async () => {
    const { serverId, account } = await fixture();
    const { DeploymentPreparationEntry } = await import('./DeploymentPreparation');
    const execute = vi.fn(() => ({ kind: 'handedOff' as const, sessionRef: { serverId, sessionId: 'unexpected' } }));
    await answerExternalActionAccountForHome(homes, serverId, { machineId: 'workspace-machine',
      actionId: 'deployments.prepare', tokenEpoch: 0, execute });
    const screen = await renderAccountScreen(<ModalProvider><DeploymentPreparationEntry
      lifetime={account.accountLifetime} projectSourceId="project" mode="prepare" /></ModalProvider>);
    try {
      await screen.pressByTestIdAsync('project-deployments.prepare.open');
      await waitReady(screen);
      await screen.pressByTestIdAsync('project-deployments.prepare.confirm');
      await waitForTestEvent(screen.subscribe, () => {
        expect(screen.findAllByType(SessionServerStartDraftComposerModal).length + execute.mock.calls.length).toBeGreaterThan(0);
      });
      expect(screen.findAllByType(SessionServerStartDraftComposerModal)).toHaveLength(1);
      expect(execute).not.toHaveBeenCalled();
      await act(async () => { screen.findByType(SessionServerStartDraftComposerModal).props.onResolve(null); });
      expect(execute).not.toHaveBeenCalled();
      expect(router.spies.push).not.toHaveBeenCalled();
    } finally { await screen.unmount(); account.dispose(); }
  });

  it.each([false, true])('prepares from the repository creation draft before creating an Environment (phone=%s)', async phone => {
    const { serverId, account } = await fixture();
    const { DeploymentEnvironmentDraft } = await import('./DeploymentEnvironmentDraft');
    const sessionRef = { serverId, sessionId: 'draft-prepare-session' };
    let received: unknown;
    await answerExternalActionAccountForHome(homes, serverId, { machineId: 'workspace-machine',
      actionId: 'deployments.prepare', tokenEpoch: 0, execute(raw) {
        received = DeploymentPrepareInputV1Schema.parse(raw);
        return { kind: 'handedOff', sessionRef };
      } });
    const screen = await renderAccountScreen(<ModalProvider><DeploymentEnvironmentDraft lifetime={account.accountLifetime}
      sourceId="project" phone={phone} actions={null} onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} /></ModalProvider>);
    try {
      await waitForTestEvent(screen.subscribe, () => {
        expect(screen.getTextContent()).toContain('preparation-ready-branch');
      });
      expect(screen.findByTestId('project-deployments.prepare.open')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.import.open')).not.toBeNull();
      await screen.pressByTestIdAsync('project-deployments.prepare.open');
      await waitReady(screen);
      await screen.pressByTestIdAsync('project-deployments.prepare.confirm');
      await submitSessionRecipe(screen);
      await waitForTestEvent(screen.subscribe, () => {
        expect(router.spies.push).toHaveBeenCalledWith(buildScopedSessionRouteHref(sessionRef));
      });
      expect(received).toMatchObject({ projectSourceId: 'project', sourceRevision: 3,
        baseCommit: 'a'.repeat(40), workspace: { kind: 'workspace-ref', serverId: `srv_${'7'.repeat(32)}`, id: 'checkout' } });
      expect(received).not.toHaveProperty('environmentId');
      expect(received).toMatchObject({ sessionDraft: { ...selectedRecipe,
        executionTarget: { serverId: `srv_${'7'.repeat(32)}`, machineId: 'workspace-machine' },
        directory: { kind: 'path', path: '/app' } } });
      expect(homes.artifacts(serverId).list()).toEqual([]);
    } finally { await screen.unmount(); account.dispose(); }
  });

  it.each(['source', 'account'] as const)('withdraws the retained handoff when its %s context changes', async replacement => {
    const { serverId, account } = await fixture();
    const { DeploymentPreparationEntry } = await import('./DeploymentPreparation');
    type EntryContext = React.ComponentProps<typeof DeploymentPreparationEntry>;
    const initial = { lifetime: account.accountLifetime, projectSourceId: 'project', mode: 'prepare' } satisfies EntryContext;
    const control: { replace(context: EntryContext): void; mount: object | null } = {
      replace() { throw new Error('Entry harness is not mounted'); }, mount: null,
    };
    function Harness() {
      const [context, setContext] = React.useState<EntryContext>(initial);
      const mount = React.useRef({});
      control.replace = setContext; control.mount = mount.current;
      return <ModalProvider><DeploymentPreparationEntry {...context} /></ModalProvider>;
    }
    const sessionRef = { serverId, sessionId: 'prepare-context-session' };
    await answerExternalActionAccountForHome(homes, serverId, { machineId: 'workspace-machine',
      actionId: 'deployments.prepare', tokenEpoch: 0, execute() { return { kind: 'handedOff', sessionRef }; } });
    let replacementAccount: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
    const screen = await renderAccountScreen(<Harness />);
    try {
      const originalMount = control.mount;
      await screen.pressByTestIdAsync('project-deployments.prepare.open');
      await waitReady(screen);
      await screen.pressByTestIdAsync('project-deployments.prepare.confirm');
      await submitSessionRecipe(screen);
      await waitForTestEvent(screen.subscribe, () => {
        expect(router.spies.push).toHaveBeenCalledWith(buildScopedSessionRouteHref(sessionRef));
      });
      expect(screen.findByTestId('project-deployments.prepare.result.session')).not.toBeNull();
      let next: EntryContext = { ...initial, projectSourceId: 'another-project' };
      if (replacement === 'account') {
        const replacementServerId = await homes.addHome({ name: 'Replacement', serverUrl: 'https://replacement-preparation.test',
          accountId: 'replacement-owner', currentAccount: true });
        replacementAccount = await captureLazyActionAccountContext(replacementServerId);
        next = { ...initial, lifetime: replacementAccount.accountLifetime };
      }
      const committedResultPresence: boolean[] = [];
      const stop = screen.subscribe(() => {
        committedResultPresence.push(screen.findByTestId('project-deployments.prepare.result.session') !== null);
      });
      try { await act(async () => { control.replace(next); }); } finally { stop(); }
      expect(control.mount, 'the same Entry harness must remain mounted').toBe(originalMount);
      expect(committedResultPresence).not.toContain(true);
      expect(screen.findByTestId('project-deployments.prepare.result.session')).toBeNull();
    } finally { await screen.unmount(); replacementAccount?.dispose(); account.dispose(); }
  });

  it('offers repository preparation without a configured investigation and opens the workspace choice', async () => {
    const {serverId, account} = await fixture();
    try {
      const screen = await renderAccountScreen(<ModalProvider><DeploymentEnvironmentAgentActions serverId={serverId} environmentId="staging"
        compact={false} emphasis="secondary" placement="section"
        preparation={{ lifetime: account.accountLifetime, projectSourceId: 'project' }} /></ModalProvider>);
      await screen.pressByTestIdAsync('project-deployments.prepare.open');
      expect(screen.findByTestId('project-deployments.prepare.sheet')).not.toBeNull();
      await waitReady(screen);
    } finally { account.dispose(); }
  });
  it.each(['handedOff', 'partial'] as const)('imports from Project before an Environment exists and resumes its %s Session', async kind => {
    const { serverId, account } = await fixture();
    const sessionRef = { serverId, sessionId: 'prepare-session' };
    const result: DeploymentPrepareResultV1 = kind === 'handedOff' ? { kind, sessionRef }
      : { kind, sessionRef, reason: 'child_failed', childOperationRefs: [] };
    let received: unknown;
    await answerExternalActionAccountForHome(homes, serverId, { machineId: 'workspace-machine',
      actionId: 'deployments.prepare', tokenEpoch: 0, execute(raw, context) {
        received = DeploymentPrepareInputV1Schema.parse(raw);
        expect(context.target).toEqual({ kind: 'machine', machineId: 'workspace-machine' });
        return result;
      } });
    homes.answer(serverId, 'GET /v1/deployments/environments', {
      body: { ok: true, items: [], currentDeployments: [], nextCursor: null } });
    const controller = createDeploymentReadControllerV1({ scope: { ...account.accountLifetime.scope, projectSourceId: 'project' },
      transport: createDeploymentReadTransport(account.accountLifetime) });
    const screen = await renderAccountScreen(<ModalProvider><ProjectDeploymentsView controller={controller}
      serverId={serverId} accountId="owner" sourceId="project" lifetime={account.accountLifetime}
      demand={{ mounted: true, visible: true, focused: true }} actions={createDeploymentActions(account.accountLifetime, 'project')} /></ModalProvider>);
    try {
      await act(async () => { await controller.refreshDemanded(); });
      await waitForTestEvent(screen.subscribe, () => {
        const failed = screen.findByTestId('project-deployments.unavailable');
        if (failed) throw new Error(`Project read failed: ${String(failed.props.diagnosticCode)}`);
        if (screen.findByTestId('project-deployments.empty') && !screen.findByTestId('project-deployments.import.open'))
          throw new Error('Ready Project page has no Import entry');
        expect(screen.findByTestId('project-deployments.import.open')).not.toBeNull();
      });
      await screen.pressByTestIdAsync('project-deployments.import.open');
      await act(async () => {
        screen.changeTextByTestId('project-deployments.import.tool', 'Coolify');
        screen.changeTextByTestId('project-deployments.import.paths', 'compose.yaml\n  config/coolify.json  ');
      });
      await waitReady(screen);
      await screen.pressByTestIdAsync('project-deployments.prepare.confirm');
      await submitSessionRecipe(screen);
      await waitForTestEvent(screen.subscribe, () => {
        if (kind === 'partial') expect(screen.findByTestId('project-deployments.prepare.session')).not.toBeNull();
        else {
          const refused = screen.findByTestId('project-deployments.prepare.refused');
          if (refused) throw new Error(`Prepare refused: ${String(refused.props.diagnosticCode)}`);
          expect(router.spies.push).toHaveBeenCalledWith(buildScopedSessionRouteHref(sessionRef));
        }
      });
      if (kind === 'partial') expect(screen.getTextContent()).not.toContain(t('projects.deployments.unavailableTitle'));
      expect(received).toMatchObject({ projectSourceId: 'project', sourceRevision: 3,
        repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
        baseCommit: 'a'.repeat(40), workspace: { kind: 'workspace-ref', serverId: 'srv_' + '7'.repeat(32), id: 'checkout' },
        importFrom: { tool: 'Coolify', configurationPaths: ['compose.yaml', 'config/coolify.json'] }, sessionDraft: selectedRecipe });
      if (kind === 'partial') {
        expect(screen.findByTestId('project-deployments.import.tool')?.props.value).toBe('Coolify');
        await screen.pressByTestIdAsync('project-deployments.prepare.session');
        expect(router.spies.push).toHaveBeenCalledWith(buildScopedSessionRouteHref(sessionRef));
      }
      expect(homes.artifacts(serverId).list()).toEqual([]);
    } finally { await screen.unmount(); controller.retire(); account.dispose(); }
  });

});
