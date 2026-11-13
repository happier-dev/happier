import { randomUUID } from 'node:crypto';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor, sealAutomationTriggerDefinitionStoredEnvelopeV1,
    type AutomationEventStoredDefinitionProjectionV1 } from '@happier-dev/protocol';
import { AutomationEventAdmitInputV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { AutomationEventActionHttpPathsV1, AutomationEventAdmitHttpRequestV1Schema } from '@happier-dev/protocol/automations/event';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { createPlainAccountArtifactHttpBoundary } from '@/api/artifacts/accountArtifactStore.testkit';
import { createAutomationEventAdoptedDefinitionSetHostV1 } from '@/plugins/runtime/automations/automationEventAdoptedDefinitionSetHost';
import * as persistence from '@/persistence';
import * as installationStore from '@/daemon/identity/store';
import { healthTransition } from '../../../../../packages/plugins/machine-services/src/healthObserver';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => vi.restoreAllMocks());

it('stores the portable Home in a saved health notice produced by the CLI factory', async () => {
    const artifacts = createPlainAccountArtifactHttpBoundary();
    const serverId = 'daemon-local-profile';
    const serverIdentityId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    const detail = createDeploymentEnvironmentDetailV1();
    detail.environment.serverId = serverIdentityId;
    const caller = { pluginId: 'happier.machine.services', machineId: detail.environment.controllerMachineId!, materializationId: 'installed' };
    const sourceCustody = { kind: 'managed' as const, immutableGenerationId: 'generation', installSource: 'archive' as const };
    const eventRef = { pluginId: caller.pluginId, localId: 'health-check-failed' };
    const binding = { v: 1 as const, automationId: randomUUID(), triggerId: 'health-check', triggerRevision: 1,
        triggerKind: 'pluginEvent' as const, eventRef, sourceSelectorId: randomUUID() };
    const subject = { kind: 'environment' as const, environmentId: detail.environment.id };
    const sourceInstanceId = 'health:factory';
    const definition = { v: 1 as const, sourceInstanceId, sourceConfig: { v: 1, subject, checks: [{ checkId: 'tcp',
        kind: { pluginId: caller.pluginId, localId: 'tcp' }, binding: { kind: 'healthCheck' }, config: { host: 'localhost', port: 80 },
        periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }] }, displayLabel: 'Health', filter: null, maximumObservationAgeMs: null };
    const retained: AutomationEventStoredDefinitionProjectionV1 = { automationId: binding.automationId, triggerId: binding.triggerId,
        triggerRevision: 1, eventRef, sourceSelectorId: binding.sourceSelectorId, sourceContractVersion: 1,
        observationOnly: { kind: 'observationOnly' }, observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: caller },
        payloadSchema: healthTransition.jsonSchema,
        storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding, definition }) };
    const id = detail.environment.contentArtifactId;
    artifacts.rows.set(id, { id, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Health' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(detail.content) }) });
    // Account HTTP and installation/key storage are the system boundaries. The
    // factory, Event admission, Environment opener and notice writer stay real.
    vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, machineId: caller.machineId });
    const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
    vi.spyOn(installationStore, 'readOrCreateInstallationIdentity').mockResolvedValue({ version: 1, installationId: randomUUID(), createdAt: 1,
        publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') });
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, environment: detail.environment, targetLinks: [] } });
    const writeArtifact = artifacts.writes.getMockImplementation()!;
    artifacts.writes.mockImplementation(async (url, body, config) => {
        if (new URL(String(url)).pathname === AutomationEventActionHttpPathsV1['automation.event.admit']) {
            AutomationEventAdmitHttpRequestV1Schema.parse(body);
            return { status: 200, data: { results: [{ kind: 'observed', checkpointSafe: true }],
                continuation: { kind: 'ready', accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } } } };
        }
        return writeArtifact(url, body, config);
    });
    const signal = new AbortController().signal;
    const occurrenceId = randomUUID();
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({ credentials: artifacts.credentials, caller, occurrenceId, sourceCustody,
        transport: { kind: 'checkpointedPull' }, occurrenceSignal: signal, isOccurrenceCurrent: () => true,
        revalidateCallerMaterialization: async () => true, revalidateCallerOccurrence: async () => true,
        resolveAccountEncryptionCurrentness: async () => ({ mode: 'plain', version: 1, signingKeyFingerprint: 'aemk1_signing',
            contentKeyFingerprint: null, updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }),
        resolveAccountEncryptionMaterial: async () => null,
        readStoredDefinitions: async () => ({ kind: 'page', revision: '1', definitions: [retained], nextCursor: null,
            eventDeclarationRelease: { release: { pluginId: caller.pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}` } }),
    });
    const executor = createActionExecutor(createCliActionDeps({ credentials: artifacts.credentials, token: artifacts.credentials.token,
        sessionId: 'cli-global', mode: 'plain', ctx: null, serverId, serverIdentityId, serverHttpBaseUrl: 'https://health-notices.test',
        resolveAuthenticatedAccountId: async () => 'owner', resolveAutomationEventAdoptedDefinitionSet: () => owner,
        revalidatePluginActionCallerMaterialization: async () => true, revalidatePluginActionCallerOccurrence: async () => true }));
    const result = await executor.execute('automation.event.admit', AutomationEventAdmitInputV1Schema.parse({ eventRef, occurrenceId: 'failed-1',
        occurredAt: 1000, observationReceivedAt: 1000, definitions: [{ automationId: binding.automationId, triggerId: binding.triggerId,
            triggerRevision: 1, sourceSelectorId: binding.sourceSelectorId }],
        payload: { sourceInstanceId, subject, checkId: 'tcp', transition: 'failed', observedAt: 1000 } }), {
        surface: 'plugin', signal, serverId, serverIdentityId,
        actionCaller: { kind: 'plugin', pluginId: caller.pluginId, materialization: caller, occurrenceId, sourceCustody },
    });
    expect(result).toMatchObject({ ok: true, result: { results: [{ kind: 'observed', checkpointSafe: true }] } });
    const notices = [...artifacts.rows.values()].filter(row => row.id !== id);
    expect(notices).toHaveLength(1);
    expect(decodePlainArtifactStoredContent(notices[0]!.header)).toMatchObject({
        page: { page: 'environment', environment: { serverId: serverIdentityId, environmentId: detail.environment.id } },
    });
});
