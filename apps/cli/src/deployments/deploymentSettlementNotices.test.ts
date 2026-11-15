import axios from 'axios';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { AutomationSourceSelectorIdV1Schema } from '@happier-dev/protocol/automations/automationEventDeclarationV1';
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { readOwnedNoticeArtifactV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { artifactListResponse, artifactReadResponse } from '@/testkit/http/artifactHome';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { runDeploymentBackupV1 } from '@happier-dev/deployments';
import { publishBackupFreshnessNotices } from './backups/freshness';
import { WorkflowTriggerListResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { DeploymentBackupTargetV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { createBackupSettlementNotices, createDeploymentSettlementNotices, readEnvironmentAlertDeliveryForHost } from './deploymentSettlementNotices';
import { AutomationDefinitionDetailSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { createHealthCheckSourceInstanceIdV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import type { OwnServerDeploymentRequest, OwnServerDeploymentTargetHostInput } from './targets/ownServer/ownServerDeploymentTarget';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { PushNotificationClient } from '@/api/pushNotifications';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

describe('settlement notice admission and arrival cost', () => {
  it('captures a paused saved Environment source as paused rather than legacy delivery absence', async () => {
    const credentials = { token: 'header.eyJzdWIiOiJvd25lciJ9.signature', encryption: null };
    const environmentId = 'production';
    const eventRef = HEALTH_CHECK_EVENT_REFS_V1.failed;
    const triggerId = AutomationTriggerIdSchema.parse('11111111-1111-4111-8111-111111111111');
    const binding = { v: 1 as const, automationId: 'saved-health', triggerId, triggerRevision: 0,
      triggerKind: 'pluginEvent' as const, eventRef,
      sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse('c79a9957-537c-4f21-a08d-289245801c05') };
    const source = AutomationDefinitionDetailSchema.parse({ id: binding.automationId, name: 'Saved health',
      description: null, enabled: true, targetType: null, existingSessionId: null, templateVersion: 1,
      lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [],
      observationOnly: { kind: 'observationOnly', templateVersion: 1 }, triggers: [{ id: triggerId, revision: 0,
        enabled: false, createdAt: 1, updatedAt: 1, kind: 'pluginEvent', eventRef,
        sourceSelectorId: binding.sourceSelectorId, sourceContractVersion: 1,
        observation: { kind: 'checkpointedPull', watcher: { machineId: 'observer', machineInstallationId: 'observer-installation',
          pluginId: eventRef.pluginId, materializationId: 'services' } }, sourceStatus: null, sourceCatalogStatus: null,
        triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({ binding, mode: 'plain',
          definition: { v: 1, sourceInstanceId: createHealthCheckSourceInstanceIdV1({ kind: 'environment', environmentId }),
            sourceConfig: { v: 1, subject: { kind: 'environment', environmentId }, checks: [{ checkId: 'tcp',
              kind: { pluginId: eventRef.pluginId, localId: 'tcp' }, binding: { kind: 'healthCheck' },
              config: { host: 'localhost', port: 5432 }, periodMs: 60000, consecutiveFailuresBeforeAlerting: 1 }],
              alerts: { channels: [{ channelId: 'saved-channel' }], phases: ['open', 'recovered'] } },
            displayLabel: 'Saved health', filter: null, maximumObservationAgeMs: null } })) }],
    });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { automations: [source], nextCursor: null } });
    expect(await readEnvironmentAlertDeliveryForHost({ credentials, serverHttpBaseUrl: 'http://backup-health.test' },
      environmentId, new AbortController().signal)).toEqual({ kind: 'paused' });
  });
  it.each(['plain', 'e2ee'] as const)('consumes settled deployment pairs and typed backup outcomes without reopening Source access in %s mode', async mode => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-owner' })).toString('base64url')}.signature`;
    const machineKey = new Uint8Array(randomBytes(32));
    const credentials = { token, encryption: mode === 'plain' ? null
      : { type: 'dataKey' as const, machineKey, publicKey: x25519.getPublicKey(machineKey) } };
    const push = vi.spyOn(PushNotificationClient.prototype, 'sendToAllDevicesAsync').mockResolvedValue(true);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
      notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [], channels: [
        NotificationChannelRecordV1Schema.parse({ v: 1, id: 'health-push', kind: 'expo_push', topics: { machines: true } }),
      ] } });
    const environment = createDeploymentEnvironmentDetailV1();
    const receipt = createDeploymentReceiptDetailV1();
    const admitted = { environment: structuredClone(environment), receipt: structuredClone(receipt) };
    const link = environment.targetLinks[0].targetLink;
    link.activeDeploymentId = receipt.deployment.id;
    const request: OwnServerDeploymentRequest = { actionId: 'deployments.deploy',
      input: { serverId: environment.environment.serverId, environmentId: environment.environment.id,
        expectedRevision: environment.environment.revision, targetLinkId: link.id, expectedTargetLinkRevision: link.revision,
        requestKey: 'notice-arrival', contentArtifactId: receipt.deployment.contentArtifactId,
        contentHeaderVersion: receipt.deployment.contentHeaderVersion, contentBodyVersion: receipt.deployment.contentBodyVersion },
      receipt: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
        deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state }, context: {} };
    const baseUrl = 'http://settlement-home.test';
    let environmentReads = 0;
    let receiptReads = 0;
    let mutations = 0;
    let advanceDuringNoticeRead = false;
    const rows = new Map<string, { id: string } & Record<string, unknown>>();
    // Only HTTP/storage adapters are substituted. Notice encoding, encryption,
    // retained-condition updates and delivery decisions use the real owners.
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200,
        data: createAccountEncryptionCurrentnessFixture({ mode }) };
      if (advanceDuringNoticeRead) { receipt.deployment.revision++; advanceDuringNoticeRead = false; }
      if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(url, [...rows.values()]) };
      const row = rows.get(path.split('/')[3]!);
      if (row && path.endsWith('/recipients')) return { status: 200, data: {
        artifactId: row.id, ownerAccountId: 'account-owner', access: 'owner', encryptionMode: mode,
        dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey, recipients: [],
        provenanceDataEncryptionKey: row.provenanceDataEncryptionKey,
        callerProvenanceDataEncryptionKey: row.provenanceDataEncryptionKey,
      } };
      return { status: row ? 200 : 404, data: row ?? {} };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url: string, input: unknown) => {
      if (new URL(url).pathname === '/v1/artifacts/read') return artifactReadResponse(input, id => rows.get(id) ?? null);
      const mutation = readCarrierMutation(input);
      const id = typeof mutation.id === 'string' ? mutation.id : new URL(url).pathname.split('/').at(-1)!;
      const prior = rows.get(id);
      const version = Number(prior?.bodyVersion ?? 0) + 1;
      mutations++;
      rows.set(id, { ...prior, ...mutation, id, ownerAccountId: 'account-owner', access: 'owner',
        publicAudience: 'none', encryptionMode: mode, headerVersion: version, bodyVersion: version,
        seq: version, createdAt: 1, updatedAt: version });
      return { status: 200, data: { id, success: true, headerVersion: version, bodyVersion: version } };
    });
    const host: OwnServerDeploymentTargetHostInput = { credentials, serverId: environment.environment.serverId,
      serverHttpBaseUrl: baseUrl, machineId: environment.environment.controllerMachineId!,
      async readEnvironment() { environmentReads++; return structuredClone(environment); },
      async readReceipt() { receiptReads++; return structuredClone(receipt); },
      async writeTransition() { throw new Error('Notices cannot settle deployments'); },
      runtime: { async acquire() { throw new Error('Notices cannot acquire native effects'); } } };
    const publish = createDeploymentSettlementNotices(host);
    const arrive = async (supplySettled = true) => {
      environmentReads = 0; receiptReads = 0;
      await publish(request, admitted, supplySettled
        ? { environment: structuredClone(environment), receipt: structuredClone(receipt) } : undefined, { kind: 'available' });
      const expectedReads = supplySettled ? 0 : 1;
      expect.soft({ environmentReads, receiptReads }, 'acquire a fresh pair only when the settlement owner has not supplied it')
        .toEqual({ environmentReads: expectedReads, receiptReads: expectedReads });
    };
    receipt.deployment.state = 'failed'; receipt.deployment.revision++;
    receipt.content.ownServer = { ...receipt.content.ownServer!, rollbackTarget: {
      deploymentId: 'prior-good', revision: { kind: 'repository', sha: 'a'.repeat(40) },
    } };
    await arrive(false);
    expect(mutations).toBe(1);
    const store = createCredentialedAccountArtifactStore(credentials);
    const failedArtifact = await runWithServerHttpBaseUrl(baseUrl,
      () => store.read([...rows.keys()][0]!, { includeSharedAudience: false }));
    expect(failedArtifact && readOwnedNoticeArtifactV1(failedArtifact, 'account-owner')).toMatchObject({
      page: { deploymentId: receipt.deployment.id },
      recoveryChoices: [{ actionId: 'deployments.rollback', label: expect.stringContaining('aaaaaaa'),
        input: { serverId: host.serverId, environmentId: environment.environment.id,
          targetLinkId: link.id, deploymentId: 'prior-good', contentArtifactId: environment.environment.contentArtifactId } }],
    });
    receipt.deployment.state = 'succeeded'; receipt.deployment.revision++;
    await arrive();
    expect(mutations).toBe(2);
    const artifact = await runWithServerHttpBaseUrl(baseUrl, () => store.read([...rows.keys()][0]!, { includeSharedAudience: false }));
    expect(artifact && readOwnedNoticeArtifactV1(artifact, 'account-owner')).toMatchObject({ healthPhase: 'recovered' });
    await arrive();
    await arrive();
    expect(mutations, 'equal settled arrivals publish nothing and do not reopen Source content').toBe(2);
    receipt.deployment.state = 'failed'; receipt.deployment.revision++;
    receipt.content.ownServer.rollbackTarget = null;
    advanceDuringNoticeRead = true;
    await arrive();
    expect(mutations, 'an admitted private notice may finish after the receipt revision changes').toBe(3);
    const lateArtifact = await runWithServerHttpBaseUrl(baseUrl,
      () => store.read([...rows.keys()][0]!, { includeSharedAudience: false }));
    const firstFailure = lateArtifact && readOwnedNoticeArtifactV1(lateArtifact, 'account-owner');
    expect(firstFailure).toMatchObject({ healthPhase: 'open', page: { deploymentId: receipt.deployment.id } });
    expect(firstFailure).not.toHaveProperty('recoveryChoices');

    environment.environment.protection = 'production';
    link.activeDeploymentId = undefined;
    for (const delivery of [{ kind: 'available' as const, alerts: { channels: [], phases: ['open' as const, 'recovered' as const] } }, { kind: 'paused' as const }]) {
      rows.clear(); push.mockClear();
      await publish(request, admitted, { environment: structuredClone(environment), receipt: structuredClone(receipt) }, delivery);
      expect(rows.size, 'a saved Off or paused source retains the committed Inbox notice').toBe(1);
      expect(push, 'deployment settlement consumes the alert selection captured at admission').not.toHaveBeenCalled();
    }

    const publishBackup = createBackupSettlementNotices(host);
    const retryTarget = DeploymentBackupTargetV1Schema.parse({ serverId: host.serverId,
      environmentId: environment.environment.id, targetLinkId: link.id, deploymentId: receipt.deployment.id,
      machineId: link.members[0]!.machineId, installationId: link.members[0]!.installationId });
    for (const terminal of ['cancelled', 'backup_failed', 'outcome_unknown'] as const) {
      rows.clear();
      const caller = new AbortController();
      const backup = runDeploymentBackupV1({ environmentId: environment.environment.id,
        configuration: { configRevision: 1, destinationRef: { pluginId: 'example.storage', localId: 's3' },
          occurrenceId: 'storage', config: { bucket: 'recovery' },
          credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }],
          sources: [{ kind: 'dump', sourceId: 'main', service: 'db', consistency: 'logical' }],
          ownership: { environmentId: environment.environment.id, prefix: environment.environment.id },
          retention: { kind: 'keepEverything' } },
        data: [{ engine: 'postgres', service: 'db', logicalBackup: { adapter: 'postgres-v1', database: 'DATABASE_NAME' } }],
        access: { repository: 's3:https://storage.invalid/recovery', passwordFilePath: '/run/secrets/repository-password',
          credentialFiles: [], environmentVariableNames: [], s3: { region: 'us-east-1', addressing: 'path' } },
        signal: caller.signal,
        // Native process IO is the boundary. The backup owner classifies its
        // actual typed outcome and the normal callback persists C1 unchanged.
        async execute() {
          if (terminal === 'cancelled') throw Object.assign(new Error('Stopped'), { code: 'cancelled' });
          if (terminal === 'outcome_unknown') {
            caller.abort();
            return { kind: 'outcome_unknown' };
          }
          return { kind: 'completed', exitCode: 7, stdout: '', stdoutTruncated: false };
        },
        onSettled: (outcome, configRevision) => publishBackup({ environment, targetLinkId: link.id,
          operationId: `backup-${terminal}`, check: 'run', outcome, configRevision, retryTarget,
          delivery: { kind: 'available', alerts: { channels: [], phases: ['open', 'recovered'] } } }),
      });
      await expect(backup).rejects.toMatchObject({ code: terminal });
      if (terminal === 'cancelled') {
        expect(rows.size, 'deliberate cancellation is not backup failure evidence').toBe(0);
      } else {
        expect(rows.size).toBe(1);
        const artifact = await runWithServerHttpBaseUrl(baseUrl,
          () => store.read([...rows.keys()][0]!, { includeSharedAudience: false }));
        expect(artifact && readOwnedNoticeArtifactV1(artifact, 'account-owner')).toMatchObject({
          healthPhase: 'open', type: 'update', source: { kind: 'host', topic: 'service_health',
            subject: { kind: 'backup', environmentId: environment.environment.id, check: 'run' } },
        });
        expect(caller.signal.aborted).toBe(terminal === 'outcome_unknown');
        const notice = artifact && readOwnedNoticeArtifactV1(artifact, 'account-owner');
        if (terminal === 'backup_failed') expect(notice).toMatchObject({ recoveryChoices: [
          { actionId: 'deployments.backups.run', input: { ...retryTarget,
            expectedRevision: environment.environment.revision, configRevision: 1 } },
        ] });
        else expect(notice).not.toHaveProperty('recoveryChoices');
      }
    }

    rows.clear();
    const freshness = WorkflowTriggerListResultV1Schema.parse({ sets: [{ automationId: 'backup-automation',
      revision: 1, enabled: true, health: 'available', triggers: [],
      missedSchedules: [{ triggerId: '11111111-1111-4111-8111-111111111111', dueAt: 100, lastRunAt: null },
        { triggerId: '22222222-2222-4222-8222-222222222222', dueAt: 90, lastRunAt: null }] }],
      backupEnvironments: [{ serverId: host.serverId, environmentId: environment.environment.id }] });
    const freshnessHost = { ...host, async readEnvironment() {
      return { ...environment, backupTarget: { ...retryTarget, expectedRevision: environment.environment.revision, configRevision: 1 } };
    } };
    await publishBackupFreshnessNotices(freshnessHost, freshness, { kind: 'available', alerts: { channels: [], phases: ['open', 'recovered'] } });
    expect(rows.size, 'a missed occurrence opens the backup/run condition without native settlement').toBe(1);
    const missedId = [...rows.keys()][0]!;
    const missedArtifact = await runWithServerHttpBaseUrl(baseUrl, () => store.read(missedId, { includeSharedAudience: false }));
    expect(missedArtifact && readOwnedNoticeArtifactV1(missedArtifact, 'account-owner')).toMatchObject({
      recoveryChoices: [{ actionId: 'deployments.backups.run', label: 'Run backup now', input: retryTarget }],
    });
    const afterMissed = mutations;
    await publishBackupFreshnessNotices(freshnessHost, freshness, { kind: 'available', alerts: { channels: [], phases: ['open', 'recovered'] } });
    expect(mutations, 'unchanged Automation wake publishes nothing').toBe(afterMissed);
    const successfulHistoryHost = { ...freshnessHost, async readEnvironment() {
      return { ...await freshnessHost.readEnvironment(), backupHistory: { kind: 'history' as const,
        environmentId: environment.environment.id, configRevision: 1, history: { entries: [] },
        lastSuccessfulBackup: { operationId: 'actual-later-success', completedAt: 101,
          configRevision: 1, snapshotIds: ['successful-snapshot'] } } };
    } };
    await publishBackupFreshnessNotices(successfulHistoryHost, freshness, { kind: 'available', alerts: { channels: [], phases: ['open', 'recovered'] } });
    const historyRecovered = await runWithServerHttpBaseUrl(baseUrl,
      () => store.read(missedId, { includeSharedAudience: false }));
    expect(historyRecovered && readOwnedNoticeArtifactV1(historyRecovered, 'account-owner')).toMatchObject({ healthPhase: 'recovered' });
    await publishBackup({ environment, targetLinkId: link.id, operationId: 'actual-later-success',
      check: 'run', outcome: 'succeeded', delivery: { kind: 'available', alerts: { channels: [], phases: ['open', 'recovered'] } } });
    expect([...rows.keys()]).toEqual([missedId]);
    const recoveredBackup = await runWithServerHttpBaseUrl(baseUrl,
      () => store.read(missedId, { includeSharedAudience: false }));
    expect(recoveredBackup && readOwnedNoticeArtifactV1(recoveredBackup, 'account-owner')).toMatchObject({ healthPhase: 'recovered' });
  });
});
