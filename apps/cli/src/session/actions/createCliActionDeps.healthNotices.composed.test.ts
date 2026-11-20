import { randomUUID } from 'node:crypto';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor, sealAutomationTriggerDefinitionStoredEnvelopeV1,
    type AutomationEventStoredDefinitionProjectionV1 } from '@happier-dev/protocol';
import { AutomationEventAdmitInputV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { AutomationEventActionHttpPathsV1, AutomationEventAdmitHttpRequestV1Schema } from '@happier-dev/protocol/automations/event';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { createPlainAccountArtifactHttpBoundary } from '@/api/artifacts/accountArtifactStore.testkit';
import { createAutomationEventAdoptedDefinitionSetHostV1 } from '@/plugins/runtime/automations/automationEventAdoptedDefinitionSetHost';
import * as persistence from '@/persistence';
import * as installationStore from '@/daemon/identity/store';
import { healthTransition } from '../../../../../packages/plugins/machine-services/src/healthObserver';
import { createCliActionDeps } from './createCliActionDeps';
import { createHostContributedActionInvoker } from '@/plugins/runtime/invocation/actions/hostContributedActionInvoker';
import { createTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/targetActionRegistry';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import type { InvokeContributedAction } from '@/plugins/runtime/invocation/services/actions';
import { TRIAGE_READ_SESSION_HANDOFF_CHOICES_ACTION_REF_V1 } from '@happier-dev/triage-protocol/v1';
import { TRIAGE_SESSION_HANDOFF_ACTION_REF_V1 } from '@happier-dev/triage-sources/runtime';

afterEach(() => vi.restoreAllMocks());

it.each(['inbox', 'auto_start', 'retired_caller'] as const)(
    'stores the portable Home and preserves admitted caller for %s health investigation', async mode => {
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
    const definition = { v: 1 as const, sourceInstanceId, sourceConfig: { v: 1, subject,
        ...(mode === 'inbox' ? {} : { investigation: { mode: 'auto_start', configuredActionId: 'investigate' } }), checks: [{ checkId: 'tcp',
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
    let callerCurrent = true;
    artifacts.writes.mockImplementation(async (url, body, config) => {
        if (new URL(String(url)).pathname === AutomationEventActionHttpPathsV1['automation.event.admit']) {
            AutomationEventAdmitHttpRequestV1Schema.parse(body);
            if (mode === 'retired_caller') callerCurrent = false;
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
    const handoffs: unknown[] = [];
    let targets: ReturnType<typeof createTargetActionInvocationRegistry>;
    const invokeRegistry: InvokeContributedAction = async request => {
        const result = await targets.invoke({ pluginId: request.action.pluginId, localId: request.action.localId,
            input: request.input, surface: request.surface, invocationSurface: request.surface,
            caller: request.caller, signal: request.signal });
        if (result.status === 'deferred') throw new Error('safe_health_target_deferred');
        return result;
    };
    const invokeContributedAction = createHostContributedActionInvoker({ invokeContributedAction: invokeRegistry,
        revalidatePluginActionCallerMaterialization: async ref => callerCurrent && ref.materializationId === caller.materializationId,
        revalidatePluginActionCallerOccurrence: async ref => callerCurrent && ref.occurrenceId === occurrenceId });
    const executor = createActionExecutor(createCliActionDeps({ credentials: artifacts.credentials, token: artifacts.credentials.token,
        sessionId: 'cli-global', mode: 'plain', ctx: null, serverId, serverIdentityId, serverHttpBaseUrl: 'https://health-notices.test',
        resolveAuthenticatedAccountId: async () => 'owner', resolveAutomationEventAdoptedDefinitionSet: () => owner,
        invokeContributedAction,
        revalidatePluginActionCallerMaterialization: async () => true, revalidatePluginActionCallerOccurrence: async () => true }));
    const owners = createProductionPluginInvocationServiceOwners({ actionExecutor: executor, invokeContributedAction: invokeRegistry });
    const targetOccurrenceId = createPluginRuntimeOccurrenceId(TRIAGE_SESSION_HANDOFF_ACTION_REF_V1.pluginId);
    targets = createTargetActionInvocationRegistry({ readMachineLocalDatabaseAgentLevel: async () => undefined,
        actions: [TRIAGE_READ_SESSION_HANDOFF_CHOICES_ACTION_REF_V1, TRIAGE_SESSION_HANDOFF_ACTION_REF_V1].map(action => ({
            pluginId: action.pluginId, pluginVersion: '1.0.0', occurrenceId: targetOccurrenceId,
            sourceCustody: { kind: 'development' as const, registeredRootId: 'triage-target' }, localId: action.localId,
            definition: { id: action.localId, dangerLevel: 'safe' as const, scopes: ['global' as const], surfaces: ['plugin' as const],
                inputSchema: { type: 'object' }, resultSchema: {} },
            handler: async input => {
                if (action.localId === TRIAGE_READ_SESSION_HANDOFF_CHOICES_ACTION_REF_V1.localId) return {
                    v: 1, kind: 'choices', defaultActionId: 'investigate', actions: [{ label: 'Investigate', selection: {
                        configuredActionId: 'investigate', sessionChoice: { kind: 'configured' }, agentChoice: { kind: 'configured' }, delivery: 'configured' } }] };
                handoffs.push(input);
                return { v: 1, handoff: { kind: 'sendResult', session: { serverId: serverIdentityId, sessionId: 'investigation' },
                    result: { status: 'accepted', localId: 'health-investigation' } } };
            },
        })),
        resolveAuthorizationFacts: target => ({ generation: { targetGeneration: target.occurrenceId,
            desiredGeneration: target.occurrenceId, appliedGeneration: target.occurrenceId },
            resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
        createServices: owners.createServices, resolveHostBinding: owners.resolveHostBinding,
        readCurrentPluginOccurrenceId: pluginId => pluginId === TRIAGE_SESSION_HANDOFF_ACTION_REF_V1.pluginId ? targetOccurrenceId : null,
    });
    try {
    const result = await executor.execute('automation.event.admit', AutomationEventAdmitInputV1Schema.parse({ eventRef, occurrenceId: 'failed-1',
        occurredAt: 1000, observationReceivedAt: 1000, definitions: [{ automationId: binding.automationId, triggerId: binding.triggerId,
            triggerRevision: 1, sourceSelectorId: binding.sourceSelectorId }],
        payload: { sourceInstanceId, subject, checkId: 'tcp', transition: 'failed', observedAt: 1000 } }), {
        surface: 'plugin', signal, serverId, serverIdentityId,
        actionCaller: { kind: 'plugin', pluginId: caller.pluginId, contributionLocalId: 'health-observer',
            materialization: caller, occurrenceId, sourceCustody },
    });
    expect(result).toMatchObject({ ok: true, result: { results: [{ kind: 'observed', checkpointSafe: true }] } });
    const notices = [...artifacts.rows.values()].filter(row => row.id !== id);
    expect(notices).toHaveLength(1);
    expect(decodePlainArtifactStoredContent(notices[0]!.header)).toMatchObject({
        page: { page: 'environment', environment: { serverId: serverIdentityId, environmentId: detail.environment.id } },
    });
    expect(handoffs).toHaveLength(mode === 'auto_start' ? 1 : 0);
    if (mode === 'auto_start') expect(handoffs[0]).toMatchObject({ handoff: {
        task: 'investigate', context: { kind: 'healthAlert', target: { environment: { serverId: serverIdentityId } } },
    } });
    if (mode === 'retired_caller') expect(JSON.stringify(decodePlainArtifactStoredContent(notices[0]!.body)))
        .toContain('plugin_action_caller_unavailable');
    } finally { targets.dispose(); await owners.dispose(); }
});
