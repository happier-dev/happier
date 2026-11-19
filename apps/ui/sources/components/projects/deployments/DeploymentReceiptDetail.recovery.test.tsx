import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1, projectDeploymentReceiptFactsV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1,
  createDeploymentReceiptDetailV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentOwnServerContentV1Schema, type OwnServerEnvironmentConfigurationV1 } from '@happier-dev/deployment-protocol/v1';
import { DeploymentActionInputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { act, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { renderAccountScreen as renderScreen } from '@/dev/testkit/render/renderAccountScreen';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
const router = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => router.module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
// Triage is not installed on this Home harness, so its contributed Actions are the realm boundary: the
// configured-action catalog answers the person's records and the configured run records what a press starts.
// Every other Action keeps the real front door.
const triage = vi.hoisted(() => ({ runs: [] as unknown[], readGate: null as Promise<void> | null }));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const selection = (configuredActionId: string) => ({ configuredActionId,
    sessionChoice: { kind: 'configured' }, agentChoice: { kind: 'configured' }, delivery: 'configured' });
  return { ...actual, createFrontDoorActionExecute: (...args: Parameters<typeof actual.createFrontDoorActionExecute>) => {
    const real = actual.createFrontDoorActionExecute(...args);
    const execute = (async (actionId, input, context) => {
      const action = (input as { action?: { pluginId?: string; localId?: string } } | undefined)?.action;
      if (actionId !== 'action.invoke' || action?.pluginId !== 'happier.triage') return real(actionId, input, context);
      if (action.localId === 'actions/read-v1') await triage.readGate;
      if (action.localId === 'actions/read-v1') return { ok: true, result: { v: 1, kind: 'choices', defaultActionId: 'investigate', actions: [
        { label: 'Investigate', selection: selection('investigate'), launchMode: 'start', startable: true },
        { label: 'Fix this deploy', selection: selection('deployments.fix-deploy'), launchMode: 'review', startable: true, forSubject: true },
      ] } };
      if (action.localId !== 'sessions/run-configured-v1') return { ok: false, errorCode: 'unavailable', error: 'unavailable' };
      triage.runs.push((input as { input?: unknown }).input);
      return { ok: true, result: { v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } } };
    }) as typeof real;
    return Object.assign(execute, { prepare: real.prepare, confirmed: real.confirmed });
  } };
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { DeploymentReceiptDetail } = await import('./DeploymentReceiptDetail');
const { createDeploymentActions } = await import('./deploymentActions');
const { AgentActionButton } = await import('@happier-dev/plugin-ui/components');
const { PluginSurfaceDestinationNavigationBindingProvider } = await import('@/components/plugins/surfaces/pluginSurfaceDestinationNavigation');
await import('@/sync/ops/actions/defaultActionExecutor');
const snapshotId = 'c'.repeat(64);

describe('failed deployment migration recovery', () => {
  beforeEach(async () => { await homes.reset(); triage.runs.length = 0; triage.readGate = null; });
  afterEach(standardCleanup);

  it.each([
    { policy: 'restoreBackupAndRollbackCode', capture: true, choice: 'restore' },
    { policy: 'ask', capture: true, choice: 'restore' },
    { policy: 'ask', capture: true, choice: 'code' },
    { policy: 'ask', capture: true, choice: 'cancel' },
    { policy: 'rollbackCodeOnly', capture: true, choice: 'code' },
    { policy: 'restoreBackupAndRollbackCode', capture: false, choice: 'unavailable' },
  ] as const)('$policy, capture=$capture, choice=$choice reaches the public rollback with the chosen recovery', async ({ policy, capture, choice }) => {
    const homeId = `srv_${'a'.repeat(32)}`;
    const serverId = await homes.addHome({ name: 'Recovery', serverUrl: 'https://migration-recovery.test',
      serverIdentityId: homeId, accountId: 'account-owner', currentAccount: true });
    const scope = { serverId, accountId: 'account-owner', projectSourceId: 'source-app' };
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const environment = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: homeId }) });
    const detail = policy === 'restoreBackupAndRollbackCode' && capture ? { ...environment,
      targetLinks: environment.targetLinks.map(link => ({ ...link,
        targetLink: { ...link.targetLink, activeDeploymentId: 'incumbent' } })) } : environment;
    const base = createDeploymentReceiptDetailV1();
    if (base.content.sourceIntent.kind !== 'repository') throw new Error('Expected repository fixture');
    const incumbent = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'incumbent' }),
      content: { ...base.content, sourceIntent: { ...base.content.sourceIntent, sha: 'b'.repeat(40) } } });
    const configuration: OwnServerEnvironmentConfigurationV1 = { rollout: 'recreate', autoRestorePreviousRelease: true,
      migration: { service: 'app', argv: ['migrate'] }, migrationFailurePolicy: policy, backupBeforeMigration: capture };
    const content = DeploymentOwnServerContentV1Schema.parse({ ...base.content,
      failure: { code: 'deployment_failed', phase: 'activate' },
      machineResults: [], steps: [{ id: 'own-server-migration', label: 'Run candidate migration', state: 'failed' }],
      ownServer: { approvedInputBasis: {
        v: 1, environmentId: detail.environment.id, environmentRevision: 1, targetLinkId: base.deployment.targetLinkId,
        targetLinkRevision: 1, sourceIntent: base.content.sourceIntent, manifestFingerprint: 'manifest',
        configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.40.1', services: ['app'], profiles: [],
        members: [{ machineId: 'machine-a', installationId: 'installation-a' }], bindings: [], images: [], ownServer: configuration,
      }, rollbackTarget: { deploymentId: incumbent.deployment.id, revision: { kind: 'repository', sha: 'b'.repeat(40) } },
      ...(capture ? { preMigrationBackup: {
        sourceFormat: 'postgresCustom', target: { service: 'app', adapter: 'postgres-v1', database: 'attached-database' },
        repository: { repository: 's3:https://backup.test/bucket' },
        configuration: { configRevision: 1, destinationRef: { pluginId: 'happier.backup.destinations', localId: 'open' },
          occurrenceId: 'destination', config: {}, credentialBindings: [], sources: [{ kind: 'dump', sourceId: 'database',
            service: 'app', consistency: 'logical' }], ownership: { environmentId: detail.environment.id, prefix: 'app' },
          retention: { kind: 'keepEverything' } },
        source: { schemaVersion: 1, environmentId: detail.environment.id, sourceId: 'database', kind: 'dump', configRevision: 1,
          repositoryId: 'a'.repeat(64), producerChecksumSha256: 'b'.repeat(64), totalBytesProcessed: 42, totalFilesProcessed: 1,
          snapshot: { snapshotId, treeId: 'd'.repeat(64), hostname: 'runtime', time: '2026-11-01T12:00:00Z', paths: ['dump'], tags: [] } },
      } } : {}) },
    });
    const receipt = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ id: 'failed-migration', state: 'failed',
      requestedAtMs: 2000, startedAtMs: 2001, settledAtMs: 2002 }), content });
    const controller = createDeploymentReadControllerV1({ scope: { ...scope, serverId: homeId }, transport: {
      listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
      readEnvironment: async () => ({ ok: true, value: detail }),
      listHistory: async () => ({ ok: true, value: { ok: true, items: [receipt, incumbent, ...(detail.targetLinks[0]?.targetLink.activeDeploymentId === incumbent.deployment.id ? [] : [base])]
        .map(row => ({ ...row.deployment, source: projectDeploymentReceiptFactsV1(row).source })), nextCursor: null } }),
      readReceipt: async (_scope, _environmentId, id) => ({ ok: true, value: id === incumbent.deployment.id ? incumbent
        : id === receipt.deployment.id ? receipt : base }),
    } });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(serverId);
    // Agent actions belong to the active Account: the one investigation owner reads the person's records only for its
    // own receipts. This Home harness has no active Account, so the no-recovery case (no rollback runs) applies one.
    const { storage } = await import('@/sync/domains/state/storageStore');
    const runtime = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const previousScope = storage.getState().profileScope;
    const previousRuntime = runtime.getAppliedActiveServerSnapshot();
    const previousAvailable = runtime.isAppliedActiveServerRuntimeAvailable();
    if (choice === 'unavailable') {
      storage.setState({ profileScope: { serverId, accountId: scope.accountId } });
      runtime.publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://migration-recovery.test',
        generation: previousRuntime.generation }, true);
    }
    // The person's records are read after the receipt paints; until they answer, the banner already holds its settled row.
    let answerRecords = () => {};
    if (choice === 'unavailable') triage.readGate = new Promise<void>(resolve => { answerRecords = resolve; });
    try {
      for (const [row, kind, document] of [
        [detail.environment, 'deployment-environment.v1', detail.content],
        [detail.targetLinks[0]!.targetLink, 'deployment-target-link.v1', detail.targetLinks[0]!.content],
        [incumbent.deployment, 'deployment-receipt.v1', incumbent.content],
      ] as const) await account.createArtifactDocument({ artifactId: row.contentArtifactId, header: { kind, title: 'Recovery' }, body: JSON.stringify(document) });
      homes.answer(serverId, `/v1/deployments/environments/${detail.environment.id}`, { body: { ok: true,
        environment: detail.environment, targetLinks: detail.targetLinks.map(link => link.targetLink) } });
      homes.answer(serverId, `/v1/deployments/receipts/${incumbent.deployment.id}`, { body: { ok: true, deployment: incumbent.deployment } });
      let observed: unknown;
      await answerExternalActionAccountForHome(homes, serverId, { actionId: 'deployments.rollback',
        machineId: 'machine-a', installationId: 'installation-a', tokenEpoch: 0,
        deploymentSource: { id: detail.environment.projectSourceId, revision: 1 },
        requesterInvocation: 'required', execute: input => {
          observed = DeploymentActionInputSchemasV1['deployments.rollback'].parse(input);
          return { ok: false, error: 'deployment_conflict' };
        } });
      const actions = createDeploymentActions(lifetime, scope.projectSourceId);
      let finished: (result: unknown) => void = () => {};
      const completion = new Promise<unknown>(resolve => { finished = resolve; });
      // Observe completion without substituting any Action logic; the assertion is on its real HTTP boundary.
      const rollback: typeof actions.rollback = async (...args) => {
        try { const result = await actions.rollback(...args); finished(result); return result; }
        catch (error) { finished(error); throw error; }
      };
      // The host's destination navigation is this page's route boundary: Edit action… must reach the one editor there.
      const editorOpens: unknown[] = [];
      const navigation = { targetKind: 'app' as const, registerOwner: () => () => {},
        openSurface: (request: unknown) => { editorOpens.push(request); return { ok: true as const }; } };
      const screen = await renderScreen(<PluginSurfaceDestinationNavigationBindingProvider binding={navigation}><DeploymentReceiptDetail controller={controller} environmentId={detail.environment.id}
        deploymentId={receipt.deployment.id} environmentName="Staging" demand={{ mounted: true, visible: true, focused: true }}
        accountId={scope.accountId} serverId={serverId} readLogs={null} onBack={() => {}} rollback={rollback}
        cancel={null} deploy={null} phone={false} linkPath={null} review={{ pendingId: null, request() {}, open() {} }} onOpenReceipt={() => {}} /></PluginSurfaceDestinationNavigationBindingProvider>);
      const actionId = 'project-deployments.receipt.outcome.failed.action';
      await act(async () => { await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.receipt.outcome.failed'), value => value !== null); });
      const offered = () => screen.findAllByType(AgentActionButton);
      if (choice === 'unavailable') {
        // Before the records answer, the receipt's own agent actions stand in, waiting, where they will settle: no control
        // arrives later and pushes the row (VISUAL-136 D1).
        expect(offered().map(button => [button.props.title, button.props.disabled])).toEqual([['Investigate', true], ['Fix this deploy', true]]);
        await act(async () => { answerRecords(); });
        // The receipt offers the person's own records for it, one shared agent-action control each, in their words
        // and launch modes.
        await act(async () => { await waitForTestEvent(screen.subscribe, () => offered().length, count => count === 2); });
        expect(offered().map(button => [button.props.title, button.props.launchMode]))
          .toEqual([['Investigate', 'start'], ['Fix this deploy', 'review']]);
        // One next step leads; the person's other records stay beside it, quieter (STORE-ACCEPT-1110 item 4).
        expect(offered().map(button => button.props.emphasis ?? 'primary')).toEqual(['primary', 'secondary']);
        await act(async () => { await controller.refreshDemanded(); });
        // With no recovery to offer, the agent actions are the failed receipt's way forward (D5). A press starts the
        // record it names through the configured run, with this exact receipt as the item and the mode chosen.
        const fix = offered().find(button => button.props.title === 'Fix this deploy');
        await act(async () => { fix?.props.onLaunch(fix.props.launchMode); });
        await act(async () => { await waitForTestEvent(screen.subscribe, () => triage.runs.length, count => count === 1); });
        const subject = { kind: 'deploymentReceipt', serverId, environmentId: detail.environment.id, deploymentId: receipt.deployment.id };
        expect(triage.runs).toEqual([expect.objectContaining({ handoff: expect.objectContaining({
          configuredActionId: 'deployments.fix-deploy', delivery: 'compose',
          context: { kind: 'failure', subject }, evidence: [{ kind: 'failure', subject }] }) })]);
        expect(observed).toBeUndefined();
        // Edit action… opens the ONE actions editor (Triage's page) on the record pressed, never a page-local copy.
        await act(async () => { fix?.props.onEdit?.(); });
        expect(editorOpens).toEqual([{ destination: { pluginId: 'happier.triage', localId: 'triage' },
          input: { v: 1, kind: 'actionEditor', actionId: 'deployments.fix-deploy' }, subPath: '' }]);
        return;
      }
      const { Modal } = await import('@/modal');
      vi.mocked(Modal.alert).mockClear();
      await act(async () => { await waitForTestEvent(screen.subscribe, () => screen.findByTestId(actionId), value => value !== null); });
      // Recovery leads while the failed catalog read is visible. Nothing has started an agent.
      await act(async () => { await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('investigation.agentActions.unavailable'), value => value !== null); });
      expect(offered()).toHaveLength(0);
      expect(triage.runs).toEqual([]);
      await screen.pressByTestIdAsync(actionId);
      if (policy === 'ask') {
        expect(observed).toBeUndefined();
        const buttons = vi.mocked(Modal.alert).mock.calls.at(-1)?.[2];
        expect(buttons).toHaveLength(3);
        const button = choice === 'cancel' ? buttons?.find(button => button.style === 'cancel')
          : buttons?.find(button => choice === 'restore' ? /backup/i.test(button.text) : /code only/i.test(button.text));
        expect(button).toBeDefined();
        await act(async () => { button?.onPress?.(); });
      } else if (choice === 'restore') expect(screen.getTextContent()).toMatch(/backup/i);
      if (choice === 'cancel') {
        expect(observed).toBeUndefined();
        expect(homes.requestsFor('/v1/actions/deployments.rollback')).toHaveLength(0);
      } else {
        let result: unknown;
        await act(async () => { result = await completion; });
        expect(observed, JSON.stringify(result)).toMatchObject({ environmentId: detail.environment.id, deploymentId: incumbent.deployment.id,
          ...(choice === 'restore' ? { restoreBackupId: snapshotId } : {}) });
        if (choice === 'code') expect(observed).not.toHaveProperty('restoreBackupId');
        expect(homes.requestsFor('/v1/actions/deployments.rollback')).toHaveLength(1);
      }
    } finally {
      await act(async () => {
        controller.retire(); account.dispose();
        if (choice === 'unavailable') {
          storage.setState({ profileScope: previousScope });
          runtime.publishAppliedActiveServerSnapshot(previousRuntime, previousAvailable);
        }
      });
    }
  });
});
