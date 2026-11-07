import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1, projectDeploymentReceiptFactsV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1,
  createDeploymentReceiptDetailV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentOwnServerContentV1Schema, type OwnServerEnvironmentConfigurationV1 } from '@happier-dev/deployment-protocol/v1';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { DeploymentActionInputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { act, renderScreen, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
const router = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => router.module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { DeploymentReceiptDetail } = await import('./DeploymentReceiptDetail');
// The app shell's one Account investigation owner, which every failure page borrows.
const { AccountNoticeInvestigationBoundary } = await import('@/hooks/inbox/AccountNoticeInvestigationProvider');
const { createDeploymentActions } = await import('./deploymentActions');
await import('@/sync/ops/actions/defaultActionExecutor');
const snapshotId = 'c'.repeat(64);

describe('failed deployment migration recovery', () => {
  beforeEach(() => homes.reset());
  afterEach(standardCleanup);

  it.each([
    { policy: 'restoreBackupAndRollbackCode', capture: true, choice: 'restore' },
    { policy: 'ask', capture: true, choice: 'restore' },
    { policy: 'ask', capture: true, choice: 'code' },
    { policy: 'ask', capture: true, choice: 'cancel' },
    { policy: 'restoreBackupAndRollbackCode', capture: false, choice: 'unavailable' },
    { policy: 'rollbackCodeOnly', capture: true, choice: 'code' },
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
    try {
      for (const [row, kind, document] of [
        [detail.environment, 'deployment-environment.v1', detail.content],
        [detail.targetLinks[0]!.targetLink, 'deployment-target-link.v1', detail.targetLinks[0]!.content],
        [incumbent.deployment, 'deployment-receipt.v1', incumbent.content],
      ] as const) await account.createArtifactDocument({ artifactId: row.contentArtifactId, header: { kind, title: 'Recovery' }, body: JSON.stringify(document) });
      homes.answer(serverId, `/v1/deployments/environments/${detail.environment.id}`, { body: { ok: true,
        environment: detail.environment, targetLinks: detail.targetLinks.map(link => link.targetLink) } });
      homes.answer(serverId, `/v1/deployments/receipts/${incumbent.deployment.id}`, { body: { ok: true, deployment: incumbent.deployment } });
      const machine = createPlainMachineRowFixture({ id: 'machine-a', accountId: scope.accountId });
      homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
        body: await createMachineReadBatchResponseFixture(body, id => id === machine.id ? machine : null).json(),
      }) });
      let observed: unknown;
      homes.answer(serverId, '/v1/actions/deployments.rollback', { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
        observed = DeploymentActionInputSchemasV1['deployments.rollback'].parse(envelope.input);
        return { body: { v: 1, actionId: 'deployments.rollback', requestId: envelope.requestId,
          execution: { ok: true, result: { ok: false, error: 'deployment_conflict' } } } };
      } });
      const actions = createDeploymentActions(lifetime, scope.projectSourceId);
      let finished: (result: unknown) => void = () => {};
      const completion = new Promise<unknown>(resolve => { finished = resolve; });
      // Observe completion without substituting any Action logic; the assertion is on its real HTTP boundary.
      const rollback: typeof actions.rollback = async (...args) => {
        try { const result = await actions.rollback(...args); finished(result); return result; }
        catch (error) { finished(error); throw error; }
      };
      const screen = await renderScreen(<AccountNoticeInvestigationBoundary><DeploymentReceiptDetail controller={controller} environmentId={detail.environment.id}
        deploymentId={receipt.deployment.id} environmentName="Staging" demand={{ mounted: true, visible: true, focused: true }}
        accountId={scope.accountId} serverId={serverId} readLogs={null} onBack={() => {}} rollback={rollback}
        cancel={null} deploy={null} phone={false} linkPath={null} review={{ pendingId: null, request() {}, open() {} }} onOpenReceipt={() => {}} /></AccountNoticeInvestigationBoundary>);
      const actionId = 'project-deployments.receipt.outcome.failed.action';
      await act(async () => { await waitForTestEvent(screen.subscribe,
        () => screen.findByTestId('project-deployments.receipt.outcome.failed'), value => value !== null); });
      if (choice === 'unavailable') {
        await act(async () => { await controller.refreshDemanded(); });
        // With no recovery to offer, finding out why is the failed receipt's one way forward (D5). This Home has
        // no configured Triage, so the shared owner's typed refusal is shown rather than nothing happening.
        await screen.pressByTestIdAsync(actionId);
        expect(observed).toBeUndefined();
        await act(async () => { await waitForTestEvent(screen.subscribe,
          () => screen.findByTestId('project-deployments.receipt.investigate.unavailable'), value => value !== null); });
        return;
      }
      const { Modal } = await import('@/modal');
      vi.mocked(Modal.alert).mockClear();
      await act(async () => { await waitForTestEvent(screen.subscribe, () => screen.findByTestId(actionId), value => value !== null); });
      // Recovery leads; Investigate stays beside it.
      expect(screen.findByTestId('project-deployments.receipt.outcome.failed.secondaryAction')).not.toBeNull();
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
    } finally { await act(async () => { controller.retire(); account.dispose(); }); }
  });
});
