import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor, sealAutomationTriggerDefinitionStoredEnvelopeV1,
    type AutomationEventStoredDefinitionProjectionV1 } from '@happier-dev/protocol';
import { AutomationEventAdmitInputV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { ActionsSettingsV1Schema, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext,
    type PluginCheckpointedEventSourceAdapterV1 } from '@happier-dev/plugin-sdk/background-services';
import { createAutomationEventAdoptedDefinitionSetHostV1 } from '@/plugins/runtime/automations/automationEventAdoptedDefinitionSetHost';
import { createAutomationEventActionExecutor } from '@/plugins/runtime/automations/automationEventActionExecutor';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import type { PluginInvocationServicesSeed } from '@/plugins/runtime/invocation/services/types';
import { createPlatformFailureNotices } from './platformFailureNotices';
import { createPlatformFailureNoticeFixture } from './platformFailureNotices.testkit';
import { DeploymentFailedEventV1ProtocolSchema, DeploymentReceiptOutcomeEventV1ProtocolSchema } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import * as persistence from '@/persistence';
import * as installationStore from '@/daemon/identity/store';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { AutomationEventActionHttpPathsV1, AutomationEventAdmitHttpRequestV1Schema } from '@happier-dev/protocol/automations/event';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';

afterEach(() => vi.restoreAllMocks());

function storedFixture(state: 'failed' | 'succeeded' = 'failed') {
    const fixture = createPlatformFailureNoticeFixture();
    const credentials = fixture.host.credentials;
    const sourceCustody = { kind: 'managed' as const, immutableGenerationId: 'retained-generation', installSource: 'archive' as const };
    const retainedFor = (state: 'failed' | 'succeeded'): AutomationEventStoredDefinitionProjectionV1 => {
        const definition = fixture.definitionFor(state);
        const binding = { v: 1 as const, automationId: definition.automationId, triggerId: definition.triggerId,
            triggerRevision: definition.triggerRevision, triggerKind: 'pluginEvent' as const,
            eventRef: definition.eventRef, sourceSelectorId: definition.sourceSelectorId };
        return {
            automationId: definition.automationId, triggerId: definition.triggerId, triggerRevision: definition.triggerRevision,
            eventRef: definition.eventRef, sourceSelectorId: definition.sourceSelectorId, sourceContractVersion: 1,
            observationOnly: { kind: 'observationOnly' }, observationTransport: definition.observationTransport,
            payloadSchema: (state === 'failed' ? DeploymentFailedEventV1ProtocolSchema : DeploymentReceiptOutcomeEventV1ProtocolSchema).jsonSchema,
            storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding,
                definition: { v: 1, sourceInstanceId: definition.sourceInstanceId, sourceConfig: definition.sourceConfig,
                    displayLabel: 'Production platform', filter: null, maximumObservationAgeMs: null } }),
        };
    };
    const currentness = { mode: 'plain' as const, version: 1, signingKeyFingerprint: 'aemk1_signing',
        contentKeyFingerprint: null, updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable' as const, reason: 'plain_account' as const } };
    return { fixture, definition: fixture.definitionFor(state), credentials, sourceCustody, retained: retainedFor(state), retainedFor, currentness };
}

it.each(['failed', 'succeeded'] as const)('commits %s C1 through the default CLI factory and opens the current Environment, link and receipt artifacts', async state => {
    const { fixture, credentials, sourceCustody, retained, currentness } = storedFixture(state);
    const protection = 'production';
    fixture.changeEnvironment(value => ({ ...value, environment: { ...value.environment, protection } }));
    const detail = await fixture.host.readEnvironment();
    const link = detail.targetLinks[0]!;
    const receipt = fixture.receipt('deployment-100', state);
    const artifactIds = [detail.environment.contentArtifactId, link.targetLink.contentArtifactId, receipt.deployment.contentArtifactId];
    for (const [index, id] of artifactIds.entries()) {
        fixture.rows.set(id, { id, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            header: encodePlainArtifactStoredContent({ kind: index === 0 ? DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1
                : index === 1 ? DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 : DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Production' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(index === 0 ? detail.content : index === 1 ? link.content : receipt.content) }) });
    }
    // Local registration/key storage is the OS boundary; the default publisher signer stays real.
    vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, machineId: fixture.caller.machineId });
    const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
    vi.spyOn(installationStore, 'readOrCreateInstallationIdentity').mockResolvedValue({ version: 1, installationId: randomUUID(), createdAt: 1,
        publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') });
    const existingGet = vi.mocked(axios.get).getMockImplementation()!;
    const reads: string[] = [];
    vi.mocked(axios.get).mockImplementation(async (url, config) => {
        const path = new URL(String(url)).pathname;
        reads.push(path);
        if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
        return existingGet(url, config);
    });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        expect(request.method).toBe('GET');
        expect(request.url).toContain(detail.environment.id);
        if (String(request.url).includes(receipt.deployment.id)) return { status: 200, data: { ok: true, deployment: receipt.deployment } };
        return { status: 200, data: { ok: true, environment: detail.environment, targetLinks: [link.targetLink] } };
    });
    const existingPost = fixture.writes.getMockImplementation()!;
    fixture.writes.mockImplementation(async (url, body, config) => {
        if (new URL(String(url)).pathname === AutomationEventActionHttpPathsV1['automation.event.admit']) {
            const request = AutomationEventAdmitHttpRequestV1Schema.parse(body);
            expect(config?.headers).toHaveProperty(PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1);
            expect(request.caller.materialization).toEqual(fixture.caller);
            return { status: 200, data: { results: [{ kind: 'observed', checkpointSafe: true }],
                continuation: { kind: 'ready', accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } } } };
        }
        return existingPost(url, body, config);
    });
    const abort = new AbortController();
    const occurrenceId = randomUUID();
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({ credentials, caller: fixture.caller, occurrenceId, sourceCustody,
        transport: { kind: 'checkpointedPull' }, occurrenceSignal: abort.signal, isOccurrenceCurrent: () => true,
        revalidateCallerMaterialization: async () => true, revalidateCallerOccurrence: async () => true,
        resolveAccountEncryptionCurrentness: async () => currentness, resolveAccountEncryptionMaterial: async () => null,
        readStoredDefinitions: async () => ({ kind: 'page', revision: '1', definitions: [retained], nextCursor: null,
            eventDeclarationRelease: { release: { pluginId: fixture.caller.pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}` } }),
    });
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
        serverId: fixture.host.serverId, serverHttpBaseUrl: fixture.host.serverHttpBaseUrl,
        resolveAutomationEventAdoptedDefinitionSet: () => owner,
        acquireAutomationEventObservationRegistry: fixture.host.acquirePluginRuntimeRegistryLease,
        revalidatePluginActionCallerMaterialization: async () => true, revalidatePluginActionCallerOccurrence: async () => true });
    const executor = createActionExecutor(deps);
    const result = await executor.execute('automation.event.admit', fixture.observation(state, 100), {
        surface: 'plugin', signal: abort.signal,
        actionCaller: { kind: 'plugin', pluginId: fixture.caller.pluginId, materialization: fixture.caller, occurrenceId, sourceCustody },
        actionsSettings: setActionApprovalOverride({ settings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
            actionId: 'automation.event.admit', surface: 'plugin', approvalRequired: false }),
    });
    expect(result).toMatchObject({ ok: true, result: { results: [{ checkpointSafe: true }] } });
    expect(reads).toEqual(expect.arrayContaining(artifactIds.map(id => `/v1/artifacts/${id}`)));
    const notices = [...fixture.rows.values()].filter(row => !artifactIds.includes(String(row.id)));
    expect(notices).toHaveLength(1);
    expect(decodePlainArtifactStoredContent(notices[0]!.header)).toMatchObject({
        type: state === 'failed' ? 'blocked' : 'update', healthPhase: state === 'failed' ? 'open' : 'recovered', resolved: false,
        title: `Staging: deployment ${state}`,
    });
    expect(decodePlainArtifactStoredContent(notices[0]!.body)).toMatchObject({ body: expect.stringContaining('provider-deployment-100') });
});

it('adopts a first direct admission before committing its platform item', async () => {
    const { fixture, credentials, sourceCustody, retained, currentness } = storedFixture();
    const abort = new AbortController();
    const occurrenceId = randomUUID();
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({ credentials, caller: fixture.caller, occurrenceId, sourceCustody,
        transport: { kind: 'checkpointedPull' }, occurrenceSignal: abort.signal, isOccurrenceCurrent: () => true,
        revalidateCallerMaterialization: async () => true, revalidateCallerOccurrence: async () => true,
        resolveAccountEncryptionCurrentness: async () => currentness, resolveAccountEncryptionMaterial: async () => null,
        readStoredDefinitions: async () => ({ kind: 'page', revision: '1', definitions: [retained], nextCursor: null,
            eventDeclarationRelease: { release: { pluginId: fixture.caller.pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}` } }),
    });
    const consume = createPlatformFailureNotices(fixture.host);
    const execute = createAutomationEventActionExecutor({ credentials,
        resolveAdoptedDefinitionSet: (_caller, _occurrence, transport) => transport.kind === 'checkpointedPull' ? owner : null,
        resolveAccountId: async () => 'owner', revalidateCallerMaterialization: async () => true, revalidateCallerOccurrence: async () => true,
        onCommittedObservation: async input => { await consume(input); },
        transport: { execute: async () => ({ results: [{ kind: 'observed', checkpointSafe: true }],
            continuation: { kind: 'ready', accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } } }) },
    });
    expect(await execute({ actionId: 'automation.event.admit', input: fixture.observation('failed', 100), signal: abort.signal,
        caller: { kind: 'plugin', pluginId: fixture.caller.pluginId, materialization: fixture.caller, occurrenceId, sourceCustody } }))
        .toMatchObject({ results: [{ checkpointSafe: true }] });
    expect(fixture.rows.size).toBe(1);
});

it.each(['production', 'nonProduction'] as const)('commits one %s generic failure item before its checkpoint, succeeds after restart, and performs no extra idle work', async protection => {
    const { fixture, credentials, sourceCustody, retained, retainedFor, currentness } = storedFixture();
    fixture.changeEnvironment(value => ({ ...value, environment: { ...value.environment, protection } }));
    let checkpoint = 0;
    let observations = 0;
    let admissions = 0;
    const commitErrors: string[] = [];
    const outcomes: unknown[] = [];
    let event = fixture.observation('failed', 100);
    const committed = createPlatformFailureNotices(fixture.host);
    const settings = setActionApprovalOverride({ settings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
        actionId: 'automation.event.admit', surface: 'plugin', approvalRequired: false });
    async function cycle(occurrenceId: string, continuous = false) {
        const currentRetained = event.eventRef.localId === 'deployment-succeeded' ? retainedFor('succeeded') : retained;
        const abort = new AbortController();
        const owner = createAutomationEventAdoptedDefinitionSetHostV1({ credentials, caller: fixture.caller, occurrenceId, sourceCustody,
            transport: { kind: 'checkpointedPull' }, occurrenceSignal: abort.signal, isOccurrenceCurrent: () => !abort.signal.aborted,
            revalidateCallerMaterialization: async () => true, revalidateCallerOccurrence: async () => true,
            resolveAccountEncryptionCurrentness: async () => currentness, resolveAccountEncryptionMaterial: async () => null,
            // Remote definition storage is the persistence boundary; adoption and opening remain real.
            readStoredDefinitions: async () => ({ kind: 'page', revision: '1', definitions: [currentRetained], nextCursor: null,
                eventDeclarationRelease: { release: { pluginId: fixture.caller.pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}` } }),
        });
        const executeEvent = createAutomationEventActionExecutor({ credentials, resolveAdoptedDefinitionSet: (_caller, _occurrence, transport) => transport.kind === 'checkpointedPull' ? owner : null,
            resolveAccountId: async () => 'owner', revalidateCallerMaterialization: async () => true, revalidateCallerOccurrence: async () => true,
            onCommittedObservation: async input => { try { await committed(input); } catch (error) { commitErrors.push(String(error)); throw error; } },
            transport: { async execute(actionId, request) {
                if (actionId === 'automation.event.source.status.report') return {};
                if (actionId !== 'automation.event.admit' || !('input' in request)) throw new Error('unexpected_transport');
                const input = AutomationEventAdmitInputV1Schema.parse(request.input);
                admissions += 1;
                // The server's observation-only result intentionally creates no Workflow run.
                return { results: input.definitions.map(() => ({ kind: 'observed', checkpointSafe: true })),
                    continuation: { kind: 'ready', accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } } };
            } },
        });
        const seed: PluginInvocationServicesSeed = { plugin: { id: fixture.caller.pluginId, version: '1.0.0' }, occurrenceId, sourceCustody,
            contribution: { id: 'observer', qualifiedId: `${fixture.caller.pluginId}/backgroundServices/observer` },
            surface: 'background', signal: abort.signal, resolveCurrentPluginMaterializationRef: () => fixture.caller,
            isOccurrenceCurrent: () => !abort.signal.aborted };
        const executor = createActionExecutor({ automationEventAction: executeEvent });
        const actions = createPluginInvocationActionsService({ seed, actionExecutor: { ...executor,
            async execute(id, input, context) { const result = await executor.execute(id, input, { ...context, actionsSettings: settings }); outcomes.push({id,result}); return result; } },
            invokeContributedAction: async () => { throw new Error('unexpected_contributed_action'); } });
        const context = { ...seed, materialization: fixture.caller, invokedAtMs: 100,
            services: { actions, events: { host: { subscribe: () => ({ dispose() {} }) } } } } as unknown as BackgroundServiceContext;
        // This authored adapter consumes a provider response and its retained checkpoint. The shared runner owns scheduling.
        const source: PluginCheckpointedEventSourceAdapterV1<string, number> = {
            decode: item => item.eventRef.pluginId === fixture.caller.pluginId ? item.sourceInstanceId : null,
            async observe({ definition: currentDefinition }) { observations += 1; return { observations: [{ ...event, sourceInstanceId: currentDefinition.sourceInstanceId,
                sourceContractVersion: 1, observedDelta: 1 }], checkpoint: checkpoint + 1, complete: true, nextEligibleAt: 2000 }; },
            async save(input) { expect(fixture.rows.size).toBe(1); checkpoint = input.checkpoint; },
            retryAt: () => null,
        };
        await runCheckpointedPluginEventObserverV1({ context, source, mode: continuous ? 'continuous' : 'once', now: () => 100,
            sleep: async delay => {
                expect(delay).toBe(1900);
                expect(observations).toBe(admissions);
                abort.abort();
            } });
        expect(observations, JSON.stringify(outcomes)).toBe(admissions);
        abort.abort();
    }
    // Artifact persistence is the real failure boundary: a safe server admission
    // cannot permit the provider cursor to discard an uncommitted notice.
    fixture.writes.mockRejectedValueOnce(new Error('notice_storage_unavailable'));
    await cycle(randomUUID());
    expect(checkpoint).toBe(0);
    expect(fixture.rows.size).toBe(0);
    expect(commitErrors).toEqual(['Error: notice_storage_unavailable']);
    await cycle(randomUUID(), true);
    expect(checkpoint, JSON.stringify({commitErrors, outcomes})).toBe(1);
    expect(fixture.rows.size).toBe(1);
    expect(decodePlainArtifactStoredContent([...fixture.rows.values()][0]!.header)).toMatchObject({
        type: protection === 'production' ? 'blocked' : 'update', healthPhase: 'open', resolved: false,
    });
    event = fixture.observation('succeeded', 200);
    await cycle(randomUUID());
    expect(checkpoint).toBe(2);
    expect(fixture.rows.size).toBe(1);
    expect(decodePlainArtifactStoredContent([...fixture.rows.values()][0]!.header)).toMatchObject({ type: 'update', healthPhase: 'recovered', resolved: false });
    const writes = fixture.writes.mock.calls.length;
    event = fixture.observation('failed', 100);
    await cycle(randomUUID());
    expect(fixture.rows.size).toBe(1);
    expect(fixture.writes.mock.calls.length).toBe(writes);
    expect(observations).toBe(4);
    expect(admissions).toBe(4);
});
