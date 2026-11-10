// @vitest-environment jsdom
import * as React from 'react';
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

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
const router = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => router.module);
const scm = vi.hoisted(() => ({ reply: undefined as unknown }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
  (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(async () => scm.reply));
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
// Load the actual lazy Action graph during collection, outside the interaction's deadline.
await import('@/sync/ops/actions/defaultActionExecutor');

async function fixture() {
  await homes.reset();
  router.resetParams(); router.spies.push.mockClear();
  const serverId = await homes.addHome({ name: 'Preparation', serverUrl: 'https://preparation-entry.test',
    accountId: 'owner', serverIdentityId: `srv_${'7'.repeat(32)}`, currentAccount: true });
  const source = { id: 'project', revision: 3, name: 'App', audience: [], createdByAccountId: 'owner',
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
  return { serverId, account };
}
async function waitReady(screen: Awaited<ReturnType<typeof renderAccountScreen>>) {
  await waitForTestEvent(screen.subscribe, () => {
    expect(screen.findByTestId('project-deployments.prepare.confirm')?.props.disabled).toBe(false);
  });
}


afterEach(async () => {
  const { Modal } = await import('@/modal');
  await act(async () => { Modal.hideAll(); });
  await standardCleanup();
});

describe('deployment preparation entry', () => {
  it('offers repository preparation without a configured investigation and opens the workspace choice', async () => {
    const {serverId, account} = await fixture();
    try {
      const screen = await renderAccountScreen(<ModalProvider><DeploymentEnvironmentAgentActions serverId={serverId} environmentId="staging"
        compact={false} emphasis="secondary" preparation={{ lifetime: account.accountLifetime, projectSourceId: 'project' }} /></ModalProvider>);
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
      await waitForTestEvent(screen.subscribe, () => {
        if (kind === 'partial') expect(screen.findByTestId('project-deployments.prepare.session')).not.toBeNull();
        else {
          const refused = screen.findByTestId('project-deployments.prepare.refused');
          if (refused) throw new Error(`Prepare refused: ${String(refused.props.diagnosticCode)}`);
          expect(router.spies.push).toHaveBeenCalledWith(buildScopedSessionRouteHref(sessionRef));
        }
      });
      expect(received).toEqual({ projectSourceId: 'project', sourceRevision: 3,
        repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
        baseCommit: 'a'.repeat(40), workspace: { kind: 'workspace-ref', serverId, id: 'checkout' },
        importFrom: { tool: 'Coolify', configurationPaths: ['compose.yaml', 'config/coolify.json'] } });
      if (kind === 'partial') {
        expect(screen.findByTestId('project-deployments.import.tool')?.props.value).toBe('Coolify');
        await screen.pressByTestIdAsync('project-deployments.prepare.session');
        expect(router.spies.push).toHaveBeenCalledWith(buildScopedSessionRouteHref(sessionRef));
      }
      expect(homes.artifacts(serverId).list()).toEqual([]);
    } finally { await screen.unmount(); controller.retire(); account.dispose(); }
  });

});
