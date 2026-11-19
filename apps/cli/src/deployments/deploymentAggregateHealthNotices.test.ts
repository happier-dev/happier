import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentHealthAggregateLeaseV1, type DeploymentHealthObservationV1 } from '@happier-dev/deployments';
import { readOwnedNoticeArtifactV1, type HealthCheckSourceConfigV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { attachDeploymentServiceHealthNotices } from '@/deployments/deploymentServiceHealthNotices';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { artifactListResponse, artifactReadResponse } from '@/testkit/http/artifactHome';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { AutomationDefinitionDetailSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { createHealthCheckSourceInstanceIdV1 } from '@happier-dev/protocol/deployments/healthCheckSubjectV1';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { PushNotificationClient } from '@/api/pushNotifications';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createAutomationAccountEncryptionMaterialSnapshotV1 } from '@/plugins/runtime/automations/automationAccountCurrentness';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createCliHealthCheckSourceSnapshotReader } from '@/session/actions/workflowTriggers';
import { assembleAutomationRuntime } from '@/plugins/runtime/composition/automationAssembly';
import { createStablePluginEventsBroker } from '@/plugins/runtime/invocation/services/events';
import { HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1 } from '@happier-dev/protocol/plugins/events/hostV1';
import { MachineReadBatchRequestV1Schema, MachineReadBatchResponseV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';

// HTTP is the only mocked system boundary; aggregation, publication, C1 encoding,
// retention, encryption and read/recovery remain real.
const http = vi.hoisted(() => ({ defaults: {}, get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('axios', () => ({ default: http }));
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

describe('P40 aggregate to one C1 Environment health condition', () => {
    it.each([
        { mode: 'plain', protection: 'production', initial: 'down' }, { mode: 'e2ee', protection: 'production', initial: 'up' },
        { mode: 'plain', protection: 'nonProduction', initial: 'unknown' }, { mode: 'e2ee', protection: 'nonProduction', initial: 'unknown' },
    ] as const)('keeps partial outage, unknown and recovery on one private $mode/$protection notice', async ({ mode, protection, initial }) => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-owner' })).toString('base64url')}.signature`;
        const machineKey = new Uint8Array(randomBytes(32));
        const credentials = { token, encryption: mode === 'plain' ? null
            : { type: 'dataKey' as const, machineKey, publicKey: x25519.getPublicKey(machineKey) } };
        const material = createAutomationAccountEncryptionMaterialSnapshotV1(credentials);
        const currentness = createAccountEncryptionCurrentnessFixture({ mode, contentKeyFingerprint: material
            ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) : null });
        const rows = new Map<string, { id: string } & Record<string, unknown>>();
        const baseUrl = 'http://aggregate-home.test';
        let mutations = 0;
        let savedSourceReads = 0;
        let savedSource: unknown;
        let malformedSourceResponse = false;
        let saveAlerts: ((alerts: NonNullable<HealthCheckSourceConfigV1['alerts']>, enabled?: boolean) => void) | undefined;
        const sourceUnavailable = mode === 'e2ee' && protection === 'production';
        http.get.mockImplementation(async (url: string) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 1 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200,
                data: currentness };
            if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(url, [...rows.values()]) };
            const id = path.split('/')[3]!;
            const row = rows.get(id);
            if (!row) return { status: 404, data: {} };
            return { status: 200, data: path.endsWith('/recipients') ? {
                artifactId: id, ownerAccountId: 'account-owner', access: 'owner', encryptionMode: mode,
                dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey, recipients: [],
                provenanceDataEncryptionKey: row.provenanceDataEncryptionKey,
                callerProvenanceDataEncryptionKey: row.provenanceDataEncryptionKey,
            } : row };
        });
        http.post.mockImplementation(async (url: string, input: unknown) => {
            if (new URL(url).pathname === '/v1/machines/read-batch') {
                const { machineIds } = MachineReadBatchRequestV1Schema.parse(input);
                return { status: 200, data: MachineReadBatchResponseV1Schema.parse({
                    results: machineIds.map(machineId => ({ machineId, status: 'not_found' })),
                }) };
            }
            if (new URL(url).pathname === '/v3/automations/query') {
                savedSourceReads++;
                if (sourceUnavailable) throw Object.assign(new Error('Saved source unavailable'), { code: 'health_source_access_unavailable' });
                if (malformedSourceResponse) return { status: 200, data: { automations: null, nextCursor: null } };
                return { status: 200, data: { automations: savedSource ? [savedSource] : [], nextCursor: null } };
            }
            if (new URL(url).pathname === '/v1/artifacts/read') return artifactReadResponse(input, id => rows.get(id) ?? null);
            const mutation = readCarrierMutation(input);
            const id = typeof mutation.id === 'string' ? mutation.id : new URL(url).pathname.split('/').at(-1)!;
            const prior = rows.get(id);
            const version = Number(prior?.bodyVersion ?? 0) + 1;
            mutations += 1;
            rows.set(id, { ...prior, ...mutation, id, ownerAccountId: 'account-owner', access: 'owner',
                publicAudience: 'none', encryptionMode: mode, headerVersion: version, bodyVersion: version,
                seq: version, createdAt: 1, updatedAt: version });
            return { status: 200, data: { id, success: true, headerVersion: version, bodyVersion: version } };
        });
        const environment = createDeploymentEnvironmentHeaderV1({ protection, controllerMachineId: 'a',
            ingress: { kind: 'edgeCaddy', edgeMachineId: 'edge' } });
        const push = vi.spyOn(PushNotificationClient.prototype, 'sendToAllDevicesAsync').mockResolvedValue(true);
        const savedOff = mode === 'plain' && protection === 'production';
        const savedRecovery = mode === 'plain' && protection === 'nonProduction';
        if (savedOff || savedRecovery) {
            const eventRef = HEALTH_CHECK_EVENT_REFS_V1.failed;
            const triggerId = AutomationTriggerIdSchema.parse('11111111-1111-4111-8111-111111111111');
            const binding = { v: 1 as const, automationId: 'saved-health', triggerId, triggerRevision: 0,
                triggerKind: 'pluginEvent' as const, eventRef, sourceSelectorId: 'c79a9957-537c-4f21-a08d-289245801c05' };
            saveAlerts = (alerts, enabled = true) => { savedSource = AutomationDefinitionDetailSchema.parse({ id: binding.automationId, name: 'Saved health',
                description: null, enabled: true, targetType: null, existingSessionId: null, templateVersion: 1,
                lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [],
                observationOnly: { kind: 'observationOnly', templateVersion: 1 }, triggers: [{ id: triggerId, revision: 0,
                    enabled, createdAt: 1, updatedAt: 1, kind: 'pluginEvent', eventRef,
                    sourceSelectorId: binding.sourceSelectorId, sourceContractVersion: 1,
                    observation: { kind: 'checkpointedPull', watcher: { machineId: 'a', machineInstallationId: 'installation-a',
                        pluginId: eventRef.pluginId, materializationId: 'services' } }, sourceStatus: null, sourceCatalogStatus: null,
                    triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({ binding, mode: 'plain',
                        definition: { v: 1, sourceInstanceId: createHealthCheckSourceInstanceIdV1({ kind: 'environment', environmentId: environment.id }),
                            sourceConfig: { v: 1, subject: { kind: 'environment', environmentId: environment.id }, checks: [{
                                checkId: 'http', kind: { pluginId: eventRef.pluginId, localId: 'http' }, binding: { kind: 'healthCheck' },
                                config: { endpoint: 'https://app.test', expectStatus: 200 }, periodMs: 60000, consecutiveFailuresBeforeAlerting: 1 }],
                                alerts }, displayLabel: 'Saved health', filter: null,
                            maximumObservationAgeMs: null } })) }] }); };
            saveAlerts({ channels: savedOff ? [] : [{ channelId: 'health-push' }],
                phases: savedOff ? ['open', 'recovered'] : ['recovered'] });
            setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
                loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
                notificationChannelCatalog: { status: 'ready', revision: 1, diagnostics: [], channels: [
                    NotificationChannelRecordV1Schema.parse({ v: 1, id: 'health-push', kind: 'expo_push', topics: { machines: true } }),
                ] } });
        }
        let targetLink = createDeploymentTargetLinkHeaderV1({ machines: ['a', 'b', 'joining'], members: [
            { machineId: 'a', installationId: 'installation-a', state: 'active' },
            { machineId: 'b', installationId: 'installation-b', state: 'active' },
            { machineId: 'joining', installationId: 'installation-joining', state: 'joining' },
        ] });
        const observation = (machineId: string, status: DeploymentHealthObservationV1['status'], reason?: string): DeploymentHealthObservationV1 => ({
            environmentId: environment.id, targetLinkId: targetLink.id, targetLinkRevision: targetLink.revision,
            machineId, installationId: `installation-${machineId}`, observedAtMs: 1000, status, reason,
            role: machineId === 'edge' ? 'edge' : 'runtime', source: machineId === 'edge'
                ? { kind: 'domain', observerMachineId: 'a' } : { kind: 'privateProbe', fallbackDisabled: true },
        });
        const retirement = new AbortController();
        const initialSnapshot = { environment, targetLink,
            observations: [observation('a', 'up'), observation('b', initial), observation('edge', 'up')] };
        const health = createDeploymentHealthAggregateLeaseV1({ initial: initialSnapshot,
            isCurrent: () => !retirement.signal.aborted,
            retirementSignal: retirement.signal,
        });
        const readEnvironment = async () => createDeploymentEnvironmentDetailV1({ environment,
            targetLinks: [{ targetLink, content: {} }], healthAggregate: health.snapshot() });
        const assembly = await assembleAutomationRuntime({ credentials, activationTargets: [], activatedPluginIds: new Set(),
            resolveCurrentMaterialization: () => null, readPluginOccurrenceId: () => null, readPluginSourceCustody: () => null,
            resolveConsumerLifecycle: () => { throw new Error('No activated plugin source'); },
            revalidateCallerMaterialization: async () => false, revalidateCallerOccurrence: async () => false,
            readHealthSources: createCliHealthCheckSourceSnapshotReader({ credentials, serverHttpBaseUrl: baseUrl }),
        });
        const broker = createStablePluginEventsBroker();
        const sourceSubscription = broker.subscribeHost({
            target: { eventId: HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1, scope: { kind: 'account' } },
            isCurrent: () => true,
            listener: event => { if (!('definitionsChanged' in event.payload) || event.payload.definitionsChanged !== false) assembly.invalidateSourceDefinitions(); },
        });
        const invalidateSource = () => broker.publishHostEventEnvelope({
            eventId: HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1,
            scope: { kind: 'account' }, payload: { definitionsChanged: true },
        });
        // P40's real lease owns immediate adoption and changed-only delivery.
        // Empty legacy handles discriminate the old service-only consumer.
        const input = { credentials, serverId: environment.serverId, homeServerIdentityId: environment.serverId, serverHttpBaseUrl: baseUrl, machineId: 'a',
            environment: await readEnvironment(), readEnvironment, handles: [], health,
            readHealthAlertSource: assembly.readHealthAlertSource };
        const alreadyRetired = new AbortController();
        alreadyRetired.abort();
        const retiredHealth = createDeploymentHealthAggregateLeaseV1({ initial: initialSnapshot,
            isCurrent: () => true, retirementSignal: alreadyRetired.signal });
        const retiredSubscriptions = vi.spyOn(retiredHealth, 'observe');
        const retired = attachDeploymentServiceHealthNotices({ ...input, health: retiredHealth });
        await retired.settled();
        expect(retiredSubscriptions).not.toHaveBeenCalled();
        expect(mutations).toBe(0);
        retired.dispose();
        const notices = attachDeploymentServiceHealthNotices(input);
        const store = createCredentialedAccountArtifactStore(credentials);
        const readNotice = async () => {
            expect(rows.size).toBe(1);
            const id = [...rows.keys()][0]!;
            const artifact = await runWithServerHttpBaseUrl(baseUrl, () => store.read(id, { includeSharedAudience: false }));
            if (!artifact) throw new Error('Expected the committed private aggregate notice');
            expect(artifact).toMatchObject({ ownerAccountId: 'account-owner', access: 'owner', publicAudience: 'none' });
            const notice = readOwnedNoticeArtifactV1(artifact, 'account-owner');
            if (notice?.kind !== 'account_notice.v1') throw new Error('Expected an Account health notice');
            return { artifact, notice };
        };
        const publish = async (a: DeploymentHealthObservationV1['status'], b: DeploymentHealthObservationV1['status'], edge: DeploymentHealthObservationV1['status']) => {
            health.adopt({ environment, targetLink,
                observations: [observation('a', a), observation('b', b, b === 'unknown' ? 'machine_unavailable' : undefined), observation('edge', edge)] });
            await notices.settled();
            return readNotice();
        };
        try {
            await notices.settled();
            if (initial === 'down') expect((await readNotice()).notice).toHaveProperty('healthPhase', 'open');
            else expect(rows.size).toBe(0);
            const opened = await publish('up', 'down', 'up');
            if (sourceUnavailable) expect(opened.notice.body).toContain('health_source_access_unavailable');
            if (savedOff || savedRecovery) { expect(savedSourceReads).toBe(1); expect(push).not.toHaveBeenCalled(); }
            expect(opened.notice).toMatchObject({ type: protection === 'production' ? 'blocked' : 'update', healthPhase: 'open', resolved: false,
                source: { kind: 'host', topic: 'service_health', subject: { kind: 'environment',
                    environmentId: environment.id, targetLinkId: targetLink.id, condition: 'health' } },
                page: { kind: 'host', page: 'environment', targetLinkId: targetLink.id } });
            expect(opened.notice?.title).toContain('1 of 3 servers down');
            expect((await publish('down', 'down', 'up')).notice?.title).toContain('2 of 3 servers down');
            const partial = await publish('up', 'down', 'up');
            expect(partial.artifact.artifactId).toBe(opened.artifact.artifactId);
            const unknown = await publish('up', 'unknown', 'up');
            expect(unknown.notice).toMatchObject({ type: protection === 'production' ? 'blocked' : 'update', healthPhase: 'open' });
            if (protection === 'production') expect(unknown.notice?.body).toContain('machine_unavailable');
            const edge = await publish('up', 'up', 'down');
            expect(edge.artifact.artifactId).toBe(opened.artifact.artifactId);
            expect(edge.notice?.body).toContain('edge');
            const beforeEqual = mutations;
            await publish('up', 'up', 'down');
            expect(mutations).toBe(beforeEqual);
            // A membership edit cannot turn old receipts/probes into recovery.
            const stale = [observation('a', 'up'), observation('b', 'up'), observation('edge', 'up')];
            targetLink = { ...targetLink, revision: targetLink.revision + 1, machines: ['a'],
                members: targetLink.members.filter(member => member.machineId === 'a') };
            health.adopt({ environment, targetLink, observations: stale });
            expect(health.snapshot().authoritativeRecovery).toBe(false);
            await notices.settled();
            const rebased = await readNotice();
            expect(rebased.artifact.artifactId).toBe(opened.artifact.artifactId);
            expect(rebased.notice).toHaveProperty('healthPhase', 'open');
            if (rebased.artifact.body === null) throw new Error('Expected the committed notice body');
            const body = rebased.artifact.body;
            expect(await runWithServerHttpBaseUrl(baseUrl, () => store.update({
                artifactId: rebased.artifact.artifactId, expectedRevision: rebased.artifact.revision,
                header: { ...rebased.artifact.header, readAt: 123 },
                body,
            }))).toMatchObject({ ok: true });
            expect((await readNotice()).notice).toHaveProperty('readAt', 123);
            const recovered = await publish('up', 'up', 'up');
            expect(recovered.artifact.artifactId).toBe(opened.artifact.artifactId);
            expect(recovered.notice).toMatchObject({ type: 'update', healthPhase: 'recovered', resolved: false });
            expect(recovered.notice).not.toHaveProperty('readAt');
            if (savedRecovery) expect(push).toHaveBeenCalledTimes(1);
            const beforeEqualRecovery = mutations;
            await publish('up', 'up', 'up');
            expect(mutations).toBe(beforeEqualRecovery);
            if (savedRecovery && saveAlerts) {
                saveAlerts({ channels: [], phases: ['open', 'recovered'] });
                invalidateSource();
                await publish('down', 'up', 'up');
                expect(push).toHaveBeenCalledTimes(1);
                expect(savedSourceReads).toBe(2);
                saveAlerts({ channels: [{ channelId: 'changed-destination' }], phases: ['open'] });
                setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 2,
                    loadedAtMs: 2, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
                    notificationChannelCatalog: { status: 'ready', revision: 2, diagnostics: [], channels: [
                        NotificationChannelRecordV1Schema.parse({ v: 1, id: 'changed-destination', kind: 'expo_push', topics: { machines: true } }),
                    ] } });
                invalidateSource();
                await publish('up', 'up', 'up');
                await publish('down', 'up', 'up');
                expect(push).toHaveBeenCalledTimes(2);
                expect(savedSourceReads).toBe(3);
                saveAlerts({ channels: [{ channelId: 'changed-destination' }], phases: ['open'] }, false);
                invalidateSource();
                await publish('up', 'up', 'up');
                await publish('down', 'up', 'up');
                expect(push).toHaveBeenCalledTimes(2);
                expect(savedSourceReads).toBe(4);
                malformedSourceResponse = true;
                invalidateSource();
                await publish('up', 'up', 'up');
                const unavailableNotice = await publish('down', 'up', 'up');
                expect(unavailableNotice.notice.body).toContain('internal_error');
                expect(push).toHaveBeenCalledTimes(2);
            }
            const beforeRetired = mutations;
            retirement.abort();
            await publish('down', 'up', 'up');
            expect(mutations).toBe(beforeRetired);
        } finally { notices.dispose(); health.dispose(); retiredHealth.dispose(); await sourceSubscription.dispose(); }
    });
});

