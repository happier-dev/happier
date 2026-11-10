// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1, projectDeploymentReceiptFactsV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { act, standardCleanup } from '@/dev/testkit';
import { renderAccountScreen } from '@/dev/testkit/render/renderAccountScreen';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { ScmWorkingSnapshotSchema, createScmCapabilities } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { t } from '@/text';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/utils/web/reactDomCjs', async () => (await import('@/dev/testkit/mocks/reactDomCjs')).createReactDomCjsRendererMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
const router = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => router.module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true, renderCustomModals: true }).module);
// The Machine RPC is the system boundary. SCM facades, admission and comparison addressing stay real.
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { DeploymentReceiptDetail } = await import('./DeploymentReceiptDetail');
const { DeploymentEnvironmentDetail } = await import('./DeploymentEnvironmentDetail');
const { createDeploymentActions } = await import('./deploymentActions');
const { CodeBlockView } = await import('@/components/ui/code/blocks/CodeBlockView');
const { DiffViewer } = await import('@/components/ui/code/diff/DiffViewer');
const { Modal } = await import('@/modal');

async function waitForReceipt(screen: Awaited<ReturnType<typeof renderAccountScreen>>) {
  await waitForHomeGovernance(async () => {
    await act(async () => {});
    expect(screen.findByTestId('project-deployments.receipt.header'), screen.getTextContent()).not.toBeNull();
  });
}

describe('retained stored deployment source', () => {
  beforeEach(async () => { await homes.reset(); rpc.mockReset(); router.spies.push.mockClear(); });
  afterEach(async () => { Modal.hideAll(); await standardCleanup(); });

  it.each(['deploy', 'teardown'] as const)('keeps exact retained definition history for %s without claiming removed apps survive', async operation => {
    const serverId = await homes.addHome({ name: 'Definitions', serverUrl: 'https://definitions.test',
      serverIdentityId: `srv_${'a'.repeat(32)}`, accountId: 'account-owner', currentAccount: true });
    const source = { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
      document: 'services:\n  web:\n    image: example/web:old\n', publicFiles: [{ path: 'config/app.conf', content: 'mode=old' }],
      services: ['web'], profiles: ['production-profile'], primaryService: 'web' };
    const base = createDeploymentReceiptDetailV1();
    const receipt = createDeploymentReceiptDetailV1({ deployment: { ...base.deployment, operation }, content: { ...base.content, sourceIntent: source,
      ...(operation === 'teardown' ? { teardown: { reason: 'manual', targetLinkRevision: 1,
        machines: [{ machineId: 'machine-a', installationId: 'installation-a' }], resources: [], proofs: [] } } : {}),
      ownServer: { approvedInputBasis: { v: 1, environmentId: base.deployment.environmentId, environmentRevision: 1,
        targetLinkId: base.deployment.targetLinkId, targetLinkRevision: 1, sourceIntent: source,
        manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'web', toolVersion: '2.40.1',
        services: ['web'], profiles: ['production-profile'], members: [{ machineId: 'machine-a', installationId: 'installation-a' }], bindings: [], images: [] },
      sources: [{ machineId: 'machine-a', installationId: 'installation-a', deploymentId: base.deployment.id, role: 'runtime',
        manifestFingerprint: 'manifest', manifestEntries: [], rootFingerprint: 'root', sharedBinds: [{ relativePath: 'state.sqlite', services: ['web'] }] }] },
    } });
    const baseEnvironment = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
    const current = { ...source, contentRevision: 2, composeDigest: `sha256:${'b'.repeat(64)}`,
      document: 'services:\n  web:\n    image: example/web:new\n', publicFiles: [{ path: 'config/app.conf', content: 'mode=new' }], profiles: ['preview-profile'] };
    const environment = createDeploymentEnvironmentDetailV1({ environment: baseEnvironment.environment, content: { ...baseEnvironment.content, definition: current } });
    const controller = createDeploymentReadControllerV1({ scope: { serverId, accountId: 'account-owner', projectSourceId: environment.environment.projectSourceId }, transport: {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: environment }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [{ ...receipt.deployment, source: projectDeploymentReceiptFactsV1(receipt).source }], nextCursor: null } }),
      readReceipt: async () => ({ ok: true, value: receipt }),
    } });
    const screen = await renderAccountScreen(<DeploymentReceiptDetail controller={controller} environmentId={environment.environment.id}
      deploymentId={receipt.deployment.id} environmentName="Staging" demand={{ mounted: true, visible: true, focused: true }}
      accountId="account-owner" serverId={serverId} readLogs={null} onBack={() => {}} rollback={null}
      cancel={null} deploy={null} phone={false} linkPath={null} review={{ pendingId: null, request() {}, open() {} }} onOpenReceipt={() => {}} />);
    await waitForReceipt(screen);
    const documents = screen.findAllByType(CodeBlockView).map(block => block.props.code);
    expect(documents).toEqual(expect.arrayContaining([source.document, 'mode=old']));
    if (operation === 'teardown') {
      expect(screen.findByTestId('project-deployments.receipt.storage')).toBeNull();
      return;
    }
    expect(screen.findByTestId('project-deployments.receipt.storage')).not.toBeNull();
    expect(screen.findAllByProps({ children: 'state.sqlite' }).length).toBeGreaterThan(0);
    expect(screen.findAllByProps({ children: 'production-profile' }).length).toBeGreaterThan(0);
    await screen.pressByTestIdAsync('project-deployments.receipt.definition.compare');
    expect(screen.findAllByType(DiffViewer).map(diff => [diff.props.oldText, diff.props.newText]))
      .toEqual([[source.document, current.document], ['mode=old', 'mode=new']]);
    expect(screen.findAllByProps({ children: 'preview-profile' }).length).toBeGreaterThan(0);
  });

  it.each(['forward', 'equal', 'diverged', 'partial', 'mismatch', 'older'] as const)(
    'compares exact deployed and selected checkout commits with %s history', async relation => {
      const serverId = await homes.addHome({ name: 'Comparison', serverUrl: 'https://comparison.test',
        serverIdentityId: `srv_${'a'.repeat(32)}`, accountId: 'account-owner', currentAccount: true });
      const environment = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
      const receipt = createDeploymentReceiptDetailV1();
      if (receipt.content.sourceIntent.kind !== 'repository' || environment.content.definition.kind !== 'repository') throw new Error('repository fixture required');
      const baseOid = receipt.content.sourceIntent.sha;
      const headOid = relation === 'equal' ? baseOid : 'b'.repeat(40);
      let selectedHeadOid = headOid;
      const range = { kind: 'revisionRange' as const, baseOid, headOid };
      const snapshot = ScmWorkingSnapshotSchema.parse({ projectKey: 'source-app', fetchedAt: 1,
        repo: { isRepo: true, rootPath: '/source', backendId: 'git', mode: '.git' }, capabilities: createScmCapabilities({ readStatus: true, readLog: true }),
        branch: { head: 'another-branch', headOid: 'd'.repeat(40), upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false, entries: [], totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0,
          includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 } });
      rpc.mockImplementation(async ({ method }: { method: string }) => method === RPC_METHODS.SCM_STATUS_SNAPSHOT
        ? { success: true, snapshot } : method === RPC_METHODS.SCM_LOG_LIST
          ? { success: true, entries: [], revisionRange: { ...range, headOid: selectedHeadOid,
            ...(relation === 'older' ? {} : { headRef: relation === 'mismatch' ? 'wrong-source-ref' : environment.content.definition.ref }), historyComplete: relation !== 'partial',
            graphRelation: relation === 'partial' || relation === 'mismatch' || relation === 'older' ? 'forward' : relation, totalCount: relation === 'equal' ? 0 : 3 } }
          : { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unexpected RPC' });
      const controller = createDeploymentReadControllerV1({ scope: { serverId, accountId: 'account-owner', projectSourceId: environment.environment.projectSourceId }, transport: {
        listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
        readEnvironment: async () => ({ ok: true, value: environment }),
        listHistory: async () => ({ ok: true, value: { ok: true, items: [{ ...receipt.deployment, source: projectDeploymentReceiptFactsV1(receipt).source }], nextCursor: null } }),
        readReceipt: async () => ({ ok: true, value: receipt }),
      } });
      const screen = await renderAccountScreen(<DeploymentReceiptDetail controller={controller} environmentId={environment.environment.id}
        deploymentId={receipt.deployment.id} environmentName="Staging" demand={{ mounted: true, visible: true, focused: true }}
        workspaceRef={{ id: 'checkout-a', serverId, machineId: 'source-machine', rootPath: '/source', label: null,
          createdAtMs: 1, lastOpenedAtMs: null, source: { sourceId: environment.environment.projectSourceId, revision: 1 } }}
        accountId="account-owner" serverId={serverId} readLogs={null} onBack={() => {}} rollback={null}
        cancel={null} deploy={null} phone={false} linkPath={null} review={{ pendingId: null, request() {}, open() {} }} onOpenReceipt={() => {}} />);
      await waitForReceipt(screen);
      await act(async () => {});
      expect(rpc.mock.calls.find(([input]) => input.method === RPC_METHODS.SCM_LOG_LIST)?.[0]).toMatchObject({
        machineId: 'source-machine', payload: { cwd: '/source', revisionRangeFromRef: { baseOid, headRef: environment.content.definition.ref } } });
      expect(rpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.SCM_STATUS_SNAPSHOT)).toHaveLength(0);
      expect(rpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.SCM_LOG_LIST)).toHaveLength(1);
      const newerText = t('projects.deployments.editors.commitsNewer', { count: 3 });
      expect(screen.findAllByProps({ children: newerText }).length > 0).toBe(relation === 'forward');
      if (relation !== 'mismatch' && relation !== 'older') {
        await screen.pressByTestIdAsync('project-deployments.comparison.status');
        expect(router.spies.push).toHaveBeenCalledWith(expect.stringContaining(`baseOid=${baseOid}`));
        expect(router.spies.push).toHaveBeenCalledWith(expect.stringContaining(`headOid=${headOid}`));
      } else {
        expect(screen.findByTestId('project-deployments.comparison.checkout')).not.toBeNull();
      }
      if (relation === 'forward') {
        selectedHeadOid = 'e'.repeat(40);
        router.spies.push.mockClear();
        await act(async () => {});
        await screen.pressByTestIdAsync('project-deployments.comparison.status');
        expect(router.spies.push).toHaveBeenCalledWith(expect.stringContaining(`headOid=${headOid}`));
        expect(rpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.SCM_LOG_LIST)).toHaveLength(1);
        await screen.pressByTestIdAsync('project-deployments.comparison.refresh');
        expect(rpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.SCM_LOG_LIST)).toHaveLength(2);
        router.spies.push.mockClear();
        await screen.pressByTestIdAsync('project-deployments.comparison.status');
        expect(router.spies.push).toHaveBeenCalledWith(expect.stringContaining(`headOid=${selectedHeadOid}`));
        const readSignal = rpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.SCM_LOG_LIST).at(-1)?.[0].signal;
        expect(readSignal?.aborted).toBe(false);
        await act(async () => { screen.unmount(); });
        expect(readSignal?.aborted).toBe(true);
      }
    });

  it('offers a Source checkout remedy without reading the runtime Machine as the repository', async () => {
    const serverId = await homes.addHome({ name: 'Source-only', serverUrl: 'https://source-only.test',
      serverIdentityId: `srv_${'a'.repeat(32)}`, accountId: 'account-owner', currentAccount: true });
    const environment = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
    const receipt = createDeploymentReceiptDetailV1();
    const controller = createDeploymentReadControllerV1({ scope: { serverId, accountId: 'account-owner', projectSourceId: environment.environment.projectSourceId }, transport: {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: environment }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
      readReceipt: async () => ({ ok: true, value: receipt }),
    } });
    const screen = await renderAccountScreen(<DeploymentReceiptDetail controller={controller} environmentId={environment.environment.id}
      deploymentId={receipt.deployment.id} environmentName="Staging" demand={{ mounted: true, visible: true, focused: true }}
      accountId="account-owner" serverId={serverId} readLogs={null} onBack={() => {}} rollback={null}
      cancel={null} deploy={null} phone={false} linkPath={null} review={{ pendingId: null, request() {}, open() {} }} onOpenReceipt={() => {}} />);
    await waitForReceipt(screen);
    expect(screen.findByTestId('project-deployments.comparison.checkout')).not.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('deploys the displayed exact PR head through the existing deployment Action and refreshes only on request', async () => {
    const homeId = `srv_${'d'.repeat(32)}`;
    const serverId = await homes.addHome({ name: 'PR deploy', serverUrl: 'https://pr-deploy.test',
      serverIdentityId: homeId, accountId: 'account-owner', currentAccount: true });
    const environment = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
    const receipt = createDeploymentReceiptDetailV1();
    const controller = createDeploymentReadControllerV1({ scope: { serverId, accountId: 'account-owner', projectSourceId: environment.environment.projectSourceId }, transport: {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: environment }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
      readReceipt: async () => ({ ok: true, value: receipt }),
    } });
    homes.answer(serverId, `GET /v1/deployments/environments/${environment.environment.id}`, { body: { ok: true,
      environment: environment.environment, targetLinks: environment.targetLinks.map(item => item.targetLink) } });
    const observed: unknown[] = [];
    await answerExternalActionAccountForHome(homes, serverId, { machineId: environment.environment.controllerMachineId,
      actionId: 'deployments.deploy', tokenEpoch: 0, deploymentSource: { id: environment.environment.projectSourceId, revision: 1 },
      execute: input => { observed.push(input); return { ok: false, error: 'deployment_conflict' }; } });
    const lifetime = { scope: { serverId, accountId: 'account-owner' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const actions = createDeploymentActions(lifetime, environment.environment.projectSourceId);
    let head = 'b'.repeat(40);
    rpc.mockImplementation(async ({ method }: { method: string }) => method === RPC_METHODS.SCM_PULL_REQUEST_GET
      ? { success: true, pullRequest: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        number: 42, title: 'Ship preview', url: 'https://github.com/example/app/pull/42', baseBranch: 'main', headBranch: 'preview',
        headSha: head, state: 'open', checks: { state: 'pending' } } }
      : { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'No status available' });
    const screen = await renderAccountScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={environment.environment.id}
      demand={{ mounted: true, visible: true, focused: true }} accountId="account-owner" serverId={serverId}
      workspaceRef={{ id: 'checkout-a', serverId, machineId: 'source-machine', rootPath: '/source', label: null,
        createdAtMs: 1, lastOpenedAtMs: null, source: { sourceId: environment.environment.projectSourceId, revision: 1 } }}
      deploy={actions.deploy} phone={false} review={{ pendingId: null, request() {}, open() {} }} onOpenReceipt={() => {}} />);
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(screen.findByTestId('project-deployments.environment.header'), screen.getTextContent()).not.toBeNull();
    });
    expect(screen.findByTestId('project-deployments.pr.number')).not.toBeNull();
    await act(async () => { screen.changeTextByTestId('project-deployments.pr.number', '42'); });
    await screen.pressByTestIdAsync('project-deployments.pr.load');
    head = 'c'.repeat(40);
    await screen.pressByTestIdAsync('project-deployments.pr.deploy');
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(observed).toEqual([expect.objectContaining({ environmentId: environment.environment.id, requestKey: expect.any(String),
        sourceIntent: expect.objectContaining({ kind: 'repository', projectSourceId: environment.environment.projectSourceId,
          sourceRevision: 1, sha: 'b'.repeat(40), pullRequestHead: { number: 42 } }) })]);
    });
    await screen.pressByTestIdAsync('project-deployments.pr.load');
    await screen.pressByTestIdAsync('project-deployments.pr.deploy');
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(observed[1]).toMatchObject({ sourceIntent: { sha: head, pullRequestHead: { number: 42 } } });
    });
    expect(rpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.SCM_PULL_REQUEST_GET)).toHaveLength(2);
    const readSignal = rpc.mock.calls.filter(([input]) => input.method === RPC_METHODS.SCM_PULL_REQUEST_GET).at(-1)?.[0].signal;
    expect(readSignal?.aborted).toBe(false);
    await act(async () => { screen.unmount(); });
    expect(readSignal?.aborted).toBe(true);
  });

});
