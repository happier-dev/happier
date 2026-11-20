import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WorkflowEventsListOutputV1Schema } from '@happier-dev/protocol/actions/specs/workflowEvents';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/automationEventSetupResultV1';
import { WorkflowTriggerListResultV1Schema, WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { SharedSavedSecretMutationOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { sealSavedSecretResourceRecipientEnvelopeV1, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentBackupConfigurationV1Schema, DeploymentBackupHistoryResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { DeploymentBackupConfigureResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupConfigureV1';
import { DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { AutomationV3RunListResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { deploymentBackupTargetOperands, RESTIC_RUNTIME_V1, selectDeploymentRuntimeTargetLinkV1 } from '@happier-dev/deployments';
import { PLUGIN_MANIFEST as BACKUP_DESTINATIONS } from '../../../plugins/backup-destinations/src/manifest';
import { nativeRestic0191 } from '../../../../apps/cli/src/daemon/local/services/launch/nativeResticRegistry.testkit';
import { installRestoreBoundary } from '../../../../apps/cli/src/deployments/targets/ownServer/nativeRestore.testkit';
import { startAutomationsEverywhereDeploymentFixture } from '../../src/testkit/automationsEverywhereDeployment';
import type { TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { fetchAccountId } from '../../src/testkit/socialFriends';
import { fetchJson } from '../../src/testkit/http';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';
import { readWorkflowChildSession, waitForWorkflowChildSession } from '../../src/testkit/workflowChildSession';

let fixture: TeamSetupFFixture | undefined;
afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

it('P01.F3 observes a native backup failure before its first snapshot from a second Machine with any and backup selectors', async () => {
    const testDir = createRunDirs({ runLabel: 'automations-p01-f3-backup' }).testDir('backup-failure');
    const setup = await startAutomationsEverywhereDeploymentFixture(testDir, { volumeBackup: true });
    fixture = setup.fixture;
    const { actor, machine, docker, deployInput, invoke } = setup;
    const environmentAddress = { serverId: fixture.serverId, environmentId: deployInput.environmentId };
    const observer = await fixture.enrollDaemon({ ...actor, name: 'backup-observer' }, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    await fixture.assertKnownGoodMachineControl(actor, observer);
    const catalog = await actor.execute('workflow.events.list', observer.target);
    expect(catalog.ok, JSON.stringify(catalog)).toBe(true);
    if (!catalog.ok) throw new Error(catalog.errorCode);
    const event = WorkflowEventsListOutputV1Schema.parse(catalog.result).events.find(row =>
        row.event.identity.pluginId === 'happier.machine.services' && row.event.identity.localId === 'backup-failed');
    if (!event?.observationBinding) throw new Error('Backup declaration unavailable');
    const configured = await actor.execute('action.invoke', { action: event.setupAction.identity,
        expectedContributorOccurrenceId: event.setupAction.occurrenceId,
        input: { v: 1, serverId: fixture.serverId } },
    { presentUserConfirmation: { actionId: 'action.invoke' }, externalActionTarget: {
        kind: 'machine', machineId: observer.target.machineId,
        project: { machineId: observer.target.machineId, directory: observer.workspaceDir } } });
    expect(configured.ok, JSON.stringify(configured)).toBe(true);
    if (!configured.ok) throw new Error(configured.errorCode);
    const source = PluginEventAutomationSetupResultV1Schema.parse(configured.result);
    expect(source.sourceConfig).toEqual({ v: 1, serverId: fixture.serverId });
    const linked = [];
    for (const selector of [undefined, { kind: 'backup', serverId: fixture.serverId, environmentId: deployInput.environmentId }] as const) {
        const result = await actor.executeAsPerson('workflow.trigger.add', {
            target: { kind: 'inline', definition: { version: 1,
                defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
                blocks: [{ kind: 'step', id: 'diagnose', document: { text: 'Diagnose the failed backup.', references: [], attachments: [] },
                    input: [], result: { kind: 'text' } }] } },
            project: { machineId: observer.target.machineId, directory: observer.workspaceDir },
            trigger: { kind: 'pluginEvent', enabled: true, eventRef: event.event.identity,
                ...(selector ? { subject: selector } : {}), sourceInstanceId: source.sourceInstanceId,
                sourceContractVersion: source.sourceContractVersion, sourceConfig: source.sourceConfig, displayLabel: source.displayLabel,
                observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: event.observationBinding.materializationRef },
                filter: null, maximumObservationAgeMs: null },
        });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) throw new Error(result.errorCode);
        linked.push(WorkflowTriggerWriteResultV1Schema.parse(result.result));
    }
    const sourceStatus = async (trigger: (typeof linked)[number]) => {
        const listed = await actor.execute('workflow.trigger.list', {
            automationId: trigger.set.automationId, triggerId: trigger.triggerId });
        if (!listed.ok) throw new Error(listed.errorCode);
        const row = WorkflowTriggerListResultV1Schema.parse(listed.result).sets.flatMap(set => set.triggers)
            .find(row => row.id === trigger.triggerId);
        return row?.kind === 'pluginEvent' ? row.sourceStatus : undefined;
    };
    for (const trigger of linked) await waitFor(async () => (await sourceStatus(trigger))?.state === 'observing',
        { context: 'The saved backup source is observing before native backup settlement' });
    await invoke(DEPLOYMENT_DEPLOY_ACTION_ID_V1, deployInput);
    const detail = DeploymentActionOutputSchemasV1['deployments.environments.get'].parse(await invoke('deployments.environments.get', environmentAddress));
    if (!detail.ok) throw new Error(detail.error);
    await docker.registerRecordedImage('restic', RESTIC_RUNTIME_V1.image, nativeRestic0191);
    const native = await installRestoreBoundary(testDir, 'volumeBackupFailure', {
        toolDirectory: join(testDir, 'tools'), environmentId: deployInput.environmentId });
    const resourceId = randomUUID();
    const resourceDataKey = Uint8Array.from(randomBytes(32));
    const accountId = await fetchAccountId(fixture.server.baseUrl, actor.credentials.token);
    const secret = SharedSavedSecretMutationOutputV1Schema.parse(await invoke('secrets.shared.create', {
        resourceId, displayName: 'Backup repository password', kind: 'password', encryptionMode: 'e2ee', teamGrants: [], groupGrants: [],
        storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey,
            content: { v: 1, name: 'Backup repository password', kind: 'password', value: 'BACKUP_PRIVATE_SENTINEL' }, randomBytes }),
        keyEnvelopes: [{ recipientAccountId: accountId, ...sealSavedSecretResourceRecipientEnvelopeV1({
            resourceDataKey, recipientContentPublicKey: actor.credentials.encryption.publicKey, randomBytes }) }],
    }));
    const destination = BACKUP_DESTINATIONS.contributes.backupDestinations?.find(row => row.id === 'local');
    if (!destination) throw new Error('Native local backup destination unavailable');
    const repository = join(testDir, 'repository');
    await mkdir(repository);
    const configuration = DeploymentBackupConfigurationV1Schema.parse({ configRevision: 1,
        destinationRef: { pluginId: BACKUP_DESTINATIONS.id, localId: destination.id }, occurrenceId: destination.id,
        config: { path: repository }, credentialBindings: destination.credentialRoles.map(({ role }) => ({
            purpose: 'backupDestination', configKey: 'destination', role })),
        sources: [{ kind: 'volume', sourceId: 'data', service: 'app', volume: 'data', consistency: 'stopDuringCopy' }],
        ownership: { environmentId: deployInput.environmentId, prefix: '' }, retention: { kind: 'keepEverything' } });
    const saved = DeploymentBackupConfigureResultV1Schema.parse(await invoke('deployments.backups.configure', {
        serverId: fixture.serverId, environmentId: deployInput.environmentId, expectedRevision: detail.environment.revision,
        intent: 'save', configuration, backupBindings: configuration.credentialBindings.map(binding => ({ ...binding,
            source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(secret.resourceId), resourceRevision: secret.revision } })),
        explicit: { backupDestination: configuration.destinationRef, backupRetention: configuration.retention, backupSchedule: null },
    }));
    expect(saved.kind).toBe('configured');
    if (saved.kind !== 'configured') throw new Error(`Backup configuration refused: ${saved.kind}`);
    const configuredDetail = DeploymentActionOutputSchemasV1['deployments.environments.get'].parse(await invoke('deployments.environments.get', environmentAddress));
    if (!configuredDetail.ok) throw new Error('Backup Environment unavailable');
    const backupOperands = deploymentBackupTargetOperands({ environment: configuredDetail.environment,
        runtimeTargetLink: selectDeploymentRuntimeTargetLinkV1({ environment: configuredDetail.environment,
            targetLinks: configuredDetail.targetLinks.map(targetLink => ({ targetLink })) }) }, saved.configuration);
    if (!backupOperands) throw new Error('Backup Environment has no active native target');
    const backupTarget = { serverId: fixture.serverId, ...backupOperands };
    const before = DeploymentBackupHistoryResultV1Schema.parse(await invoke('deployments.backups.history', backupTarget));
    expect(before.history.entries).toEqual([]);
    const headers = { Authorization: `Bearer ${actor.credentials.token}`,
        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
    const runs = async (automationId: string) => {
        const response = await fetchJson<unknown>(`${fixture!.server.baseUrl}/v3/automations/${encodeURIComponent(automationId)}/runs`, { headers });
        expect(response.status).toBe(200);
        return AutomationV3RunListResponseSchema.parse(response.data).runs;
    };
    for (const trigger of linked) expect(await runs(trigger.set.automationId)).toEqual([]);
    const failure = await actor.executeReviewed(DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, backupTarget);
    expect(failure.ok, JSON.stringify(failure)).toBe(false);
    const history = DeploymentBackupHistoryResultV1Schema.parse(await invoke('deployments.backups.history', backupTarget));
    expect(history.history.entries).toMatchObject([{ action: 'backup', state: 'failed', snapshotIds: [] }]);
    const boundaryEvents = await readFile(native.eventsFile, 'utf8');
    expect(boundaryEvents).not.toContain('BACKUP_PRIVATE_SENTINEL');
    for (const trigger of linked) {
        await waitForWorkflowChildSession(async () => { const current = await runs(trigger.set.automationId); expect(current.length).toBeLessThanOrEqual(1);
            if (current.length !== 1) return false;
            return await readWorkflowChildSession({ execute: actor.execute, serverBaseUrl: fixture!.server.baseUrl,
                token: actor.credentials.token, runId: current[0]!.id, blockId: 'diagnose' }) !== null;
        }, 'A native failure before its first snapshot reaches the second Machine and one ordinary diagnosis Run');
        expect((await runs(trigger.set.automationId))[0]!.cause).toMatchObject({ kind: 'trigger', triggerKind: 'pluginEvent',
            triggerId: trigger.triggerId, evidence: { eventRef: event.event.identity } });
    }
    const observedRevisions = await Promise.all(linked.map(async trigger => (await sourceStatus(trigger))?.revision ?? -1));
    await observer.daemon.stop();
    const whileOffline = await actor.executeReviewed(DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, backupTarget);
    expect(whileOffline.ok, JSON.stringify(whileOffline)).toBe(false);
    const restarted = await fixture.enrollDaemon({ ...actor, name: 'backup-observer' }, {
        pairedHome: { homeDir: observer.homeDir, serverId: observer.cliServerId, machineId: observer.target.machineId },
        env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    await fixture.assertKnownGoodMachineControl(actor, restarted);
    for (const [index, trigger] of linked.entries()) {
        await waitForWorkflowChildSession(async () => {
            const current = await runs(trigger.set.automationId);
            expect(current.length).toBeLessThanOrEqual(2);
            const status = await sourceStatus(trigger);
            if (current.length !== 2 || status?.state !== 'observing' || status.revision <= observedRevisions[index]!) return false;
            const children = await Promise.all(current.map(run => readWorkflowChildSession({ execute: actor.execute,
                serverBaseUrl: fixture!.server.baseUrl, token: actor.credentials.token, runId: run.id, blockId: 'diagnose' })));
            return children.every(child => child !== null);
        }, 'Reconnect recovers the offline native backup failure without replaying its prior Run');
        expect(await runs(trigger.set.automationId)).toHaveLength(2);
    }
    expect(machine.target.machineId).not.toBe(observer.target.machineId);
}, 0);
