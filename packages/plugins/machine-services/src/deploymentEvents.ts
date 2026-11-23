import { withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { arePluginMachineMaterializationRefsEqual, computeCanonicalDomainSeparatedDigest, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_ROLLBACK_ACTION_ID_V1, DEPLOYMENT_PROMOTE_ACTION_ID_V1, DEPLOYMENT_RECEIPT_EVENT_REFS_V1, DEPLOYMENT_RECEIPT_CHANGED_EVENT_REF_V1, readDeploymentAccountChangeV1,
    DeploymentReceiptChangedEventV1ProtocolSchema as changedSchema,
    deploymentInProgressStates, DeploymentReceiptEventSourceConfigV1ProtocolSchema as configSchema,
    DeploymentReceiptEventSetupV1ProtocolSchema as setupSchema,
    DeploymentFailedEventV1ProtocolSchema as failedSchema, DeploymentRollbackCompletedEventV1ProtocolSchema as rollbackSchema,
    DeploymentReceiptOutcomeEventV1ProtocolSchema as outcomeSchema,
    createPluginEventAutomationSetupResultV1JsonSchema,
    type DeploymentReceiptEventSourceConfigV1, type HostEventPayloadById, type PluginEventObservationV1 } from '@happier-dev/plugin-sdk/events';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext,
    type PluginCheckpointedEventSourceAdapterV1, type PluginCheckpointedEventSourceDefinitionV1 } from '@happier-dev/plugin-sdk/background-services';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import { admitNativeActionCompletionObservation } from './eventCompletion.js';

const pluginId = DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.pluginId;
export const DEPLOYMENT_FAILED_EVENT = DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.localId;
const changedEvent = DEPLOYMENT_RECEIPT_CHANGED_EVENT_REF_V1.localId;
export const ROLLBACK_COMPLETED_EVENT = 'rollback-completed';
type ReceiptRead = Extract<PluginActionResultById['deployments.receipts.get'], { ok: true }>;
type Environment = Extract<PluginActionResultById['deployments.environments.get'], { ok: true }>['environment'];
type Receipt = ReceiptRead['deployment'] & Pick<ReceiptRead, 'failureSummary'> & {
    environment?: Environment;
};
function projectReadReceipt(read: ReceiptRead, header = read.deployment): Receipt {
    return {
        ...header,
        failureSummary: read.failureSummary,
    };
}
async function readReceiptEnvironment(
    context: Pick<PluginInvocationContext, 'services' | 'signal'>,
    serverId: string,
    environmentId: string,
): Promise<Environment> {
    const read = await context.services.actions.execute('deployments.environments.get', {
        serverId, environmentId,
    }, { signal: context.signal });
    if (!('ok' in read) || !read.ok) throw withActionFailureDiagnostic(new PluginError({
        code: 'ok' in read ? read.error : 'deployment_unavailable',
    }), { phase: 'deployment.events.read', causeKind: 'native_failure', error: read });
    return read.environment;
}
const outcomes = {
    [changedEvent]: { completesActionIds: undefined, state: null, operation: null, schema: changedSchema, key: 'deploymentReceiptChanged',
        title: 'Deployment receipt changed', description: 'The current deployment receipt or its serving Domain changed.' },
    [DEPLOYMENT_FAILED_EVENT]: { completesActionIds: [DEPLOYMENT_DEPLOY_ACTION_ID_V1], state: 'failed', operation: null, schema: failedSchema, key: 'deploymentFailed',
        title: 'Deployment failed', description: 'A deployment receipt settled as failed, with its recorded failure phase.' },
    [ROLLBACK_COMPLETED_EVENT]: { completesActionIds: [DEPLOYMENT_ROLLBACK_ACTION_ID_V1], state: 'succeeded', operation: 'rollback', schema: rollbackSchema, key: 'rollbackCompleted',
        title: 'Rollback completed', description: 'A rollback receipt settled successfully.' },
    [DEPLOYMENT_RECEIPT_EVENT_REFS_V1.succeeded.localId]: { completesActionIds: [DEPLOYMENT_DEPLOY_ACTION_ID_V1], state: 'succeeded', operation: null, schema: outcomeSchema, key: 'deploymentSucceeded',
        title: 'Deployment succeeded', description: 'A deployment receipt settled successfully.' },
    'promotion-completed': { completesActionIds: [DEPLOYMENT_PROMOTE_ACTION_ID_V1], state: 'succeeded', operation: 'promote', schema: outcomeSchema, key: 'promotionCompleted',
        title: 'Promotion completed', description: 'A promotion receipt settled successfully.' },
    'deployment-cancelled': { completesActionIds: [DEPLOYMENT_DEPLOY_ACTION_ID_V1], state: 'cancelled', operation: null, schema: outcomeSchema, key: 'deploymentCancelled',
        title: 'Deployment cancelled', description: 'A deployment receipt settled as cancelled.' },
    'deployment-outcome-unknown': { completesActionIds: [DEPLOYMENT_DEPLOY_ACTION_ID_V1], state: 'outcome_unknown', operation: null, schema: outcomeSchema, key: 'deploymentOutcomeUnknown',
        title: 'Deployment outcome unknown', description: 'A deployment receipt recorded an unknown outcome.' },
} as const;
type EventId = keyof typeof outcomes;
const isEventId = (id: string): id is EventId => Object.hasOwn(outcomes, id);
const sourceId = (config: DeploymentReceiptEventSourceConfigV1, event: EventId) =>
    `deployment:${computeCanonicalDomainSeparatedDigest('happier.deployment.event-source.v1', [config.serverId, config.environmentId ?? '', event, String(config.observingSince),
        ...(config.targetLinkId ? [config.targetLinkId] : []), ...(config.previewChildren ? ['previewChildren'] : [])])}`;

const setupAction = (event: EventId) => ({
    title: 'Choose deployment Environment', execution: { target: 'daemon' as const }, scopes: ['global', 'machine'] as const,
    surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'] as const, dangerLevel: 'safe' as const, readOnly: true,
    inputSchema: setupSchema,
    resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, configSchema.jsonSchema),
    async run(input: unknown, context: PluginInvocationContext) {
        const scope = setupSchema.parse(input);
        if (scope.previewChildren && event !== changedEvent) throw new PluginError({ code: 'deployment_target_unavailable' });
        let credentialPrincipal: DeploymentReceiptEventSourceConfigV1['credentialPrincipal'];
        if (scope.environmentId !== undefined) {
            const read = await context.services.actions.execute('deployments.environments.get', {
                serverId: scope.serverId, environmentId: scope.environmentId,
            }, { signal: context.signal });
            if (!('ok' in read) || !read.ok || read.environment.id !== scope.environmentId) throw withActionFailureDiagnostic(new PluginError({
                code: 'ok' in read && !read.ok ? read.error : 'deployment_unavailable', message: 'The selected Environment is unavailable.',
            }), { phase: 'deployment.events.read', causeKind: 'native_failure', error: read });
            if (scope.targetLinkId) {
                const targetLink = read.targetLinks.find(link => link.id === scope.targetLinkId);
                if (read.environment.runtimeTargetLinkId !== scope.targetLinkId || !targetLink
                    || targetLink.environmentId !== scope.environmentId || targetLink.role !== 'runtime') {
                    throw new PluginError({ code: 'deployment_target_unavailable' });
                }
                // Native settlement comes from the receipt producer. Only a
                // provider source needs retained observation credentials.
                if (targetLink.targetKind !== 'ownServer') {
                    const observation = await context.services.actions.execute('deployments.observation.get', {
                        serverId: scope.serverId, environmentId: scope.environmentId, targetLinkId: scope.targetLinkId,
                    }, { signal: context.signal });
                    if (!('ok' in observation) || !observation.ok) throw withActionFailureDiagnostic(new PluginError({
                        code: 'ok' in observation ? observation.error : 'deployment_unavailable',
                    }), { phase: 'deployment.events.read', causeKind: 'native_failure', error: observation });
                    credentialPrincipal = observation.credentialPrincipal;
                }
            }
        }
        const config = configSchema.parse({ ...scope, observingSince: context.invokedAtMs,
            ...(credentialPrincipal ? { credentialPrincipal } : {}) });
        return { v: 1 as const, sourceInstanceId: sourceId(config, event), sourceContractVersion: 1,
            sourceConfig: config, displayLabel: config.environmentId ?? 'Deployments' };
    },
});
export const deploymentEventActions = Object.fromEntries((Object.keys(outcomes) as EventId[])
    .map(id => [`${id}/setup`, setupAction(id)]));
const event = (id: EventId) => {
    const { title, schema: payloadSchema, key, description, completesActionIds } = outcomes[id];
    return { declaration: {
    kind: 'event' as const, title: { key: `machineServices.events.${key}.title`, fallback: title }, payloadSchema: payloadSchema.jsonSchema,
    description: { key: `machineServices.events.${key}.description`, fallback: description },
    automation: { v: 1 as const, eligible: true as const,
        subjectKinds: ['environment' as const, 'app' as const, 'machine' as const],
        ...(completesActionIds ? { completesActionIds: [...completesActionIds], completionOutcome: outcomes[id].state! } : {}), source: { sourceContractVersion: 1,
        supportedObservationTransports: ['checkpointedPull' as const], sourceConfigSchema: configSchema.jsonSchema,
        setupActionRef: { pluginId, localId: `${id}/setup` } } },
} };
};
export const deploymentEvents = Object.fromEntries((Object.keys(outcomes) as EventId[]).map(id => [id, event(id)]));

type ReceiptCompletion = NonNullable<HostEventPayloadById['@happier/deployment/receipt-invalidated']['completion']>;
type PendingReceipt = { receipt?: Receipt | null; completion?: ReceiptCompletion | null; environmentId?: string; latest?: true;
    templateEnvironmentId?: string | null; domains?: string };
type State = { config: DeploymentReceiptEventSourceConfigV1; event: EventId; fullRead: boolean;
    pending: Map<string, PendingReceipt>; observing: Set<string>; observations: PluginEventObservationV1[] | null };
const inProgressStates = new Set(deploymentInProgressStates());

/** Both saved Event sources and native Action completion consume this receipt projection. */
function projectReceiptObservation(input: Readonly<{
    receipt: Receipt; environment: Environment; event: EventId; serverId: string; sourceInstanceId: string;
    observationReceivedAt: number; domainFingerprint?: string; completion?: ReceiptCompletion;
}>): PluginEventObservationV1 {
    const { receipt, event } = input;
    const { projectSourceId } = input.environment;
    const observedAt = input.completion?.occurredAt ?? receipt.settledAtMs ?? receipt.startedAtMs ?? receipt.requestedAtMs;
    const identity = { environmentId: receipt.environmentId, deploymentId: receipt.id, targetLinkId: receipt.targetLinkId,
        receiptRevision: input.completion?.revision ?? receipt.revision, observedAt };
    const payload = event === DEPLOYMENT_FAILED_EVENT
        ? failedSchema.parse({ ...identity, operation: receipt.operation, state: 'failed',
            phase: receipt.failureSummary?.phase ?? null, failureCode: receipt.failureSummary?.code ?? null })
        : outcomes[event].schema.parse({ ...identity, operation: receipt.operation, state: input.completion?.state ?? receipt.state });
    return { eventRef: { pluginId, localId: event }, sourceInstanceId: input.sourceInstanceId, sourceContractVersion: 1,
        occurrenceId: computeCanonicalDomainSeparatedDigest('happier.deployment.receipt-event.v1',
            [input.serverId, receipt.environmentId, receipt.id, event, String(observedAt),
                ...(event === changedEvent ? [String(receipt.revision), input.domainFingerprint ?? ''] : [])]),
        occurredAt: observedAt, observationReceivedAt: input.observationReceivedAt, observedDelta: 1,
        ...(receipt.originRunId ? { originRunId: receipt.originRunId } : {}),
        subjectContexts: [
            { role: 'operand', subject: { kind: 'environment', serverId: input.serverId, environmentId: receipt.environmentId } },
            { role: 'context', subject: { kind: 'app', serverId: input.serverId, projectSourceId } },
            ...(receipt.acceptedExecution ? [{ role: 'context' as const, subject: { kind: 'machine' as const, serverId: input.serverId, machineId: receipt.acceptedExecution.controller.machineId } }] : []),
        ], payload };
}
function pendingEligibility(state: State, time: number): number | null {
    return state.observing.size > 0 && state.config.periodMs !== undefined
        ? Math.min(Number.MAX_SAFE_INTEGER, time + state.config.periodMs) : null;
}
/** Receipts own durable facts; this adapter holds only the current finite attempt.
 * Adoption/reconnect replays retained receipts through the existing occurrence dedupe. */
export function createDeploymentReceiptEventSourceAdapter(host: BackgroundServiceContext['services']['events']['host'],
    now: () => number = Date.now, completionContext?: PluginInvocationContext): PluginCheckpointedEventSourceAdapterV1<DeploymentReceiptEventSourceConfigV1, State> {
    const states = new Map<string, State>();
    let accountChanges: { dispose(): void } | undefined;
    let reconnect: { dispose(): void } | undefined;
    let wakeSources: Parameters<NonNullable<PluginCheckpointedEventSourceAdapterV1<DeploymentReceiptEventSourceConfigV1, State>['subscribeWake']>>[0] | undefined;
    const updateSourceSubscriptions = () => {
        if (states.size === 0 || !wakeSources) { reconnect?.dispose(); reconnect = undefined; }
        else if (!reconnect) reconnect = host.subscribe({
            eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' },
        }, async event => {
            if (event.payload.reason !== 'reconnect') return;
            for (const state of states.values()) state.fullRead = true;
            await wakeSources?.();
        });
        const needed = [...states.values()].some(state => state.event === changedEvent);
        if (!needed || !wakeSources) { accountChanges?.dispose(); accountChanges = undefined; }
        else if (!accountChanges) accountChanges = host.subscribe({
            eventId: '@happier/account/entities-invalidated', scope: { kind: 'account' },
        }, async event => {
            for (const entityId of event.payload.entityIds) {
                const change = readDeploymentAccountChangeV1({ kind: 'account', entityId });
                if (!change || change.deploymentId || change.activityChanged) continue;
                const entries = new Map<string, PendingReceipt>();
                for (const [id, state] of states) {
                    if (state.event !== changedEvent || state.config.environmentId !== undefined && !state.config.previewChildren && state.config.environmentId !== change.environmentId) continue;
                    const entry: PendingReceipt = entries.get(state.config.serverId) ?? { environmentId: change.environmentId, latest: true };
                    entries.set(state.config.serverId, entry);
                    state.pending.set(`environment:${change.environmentId}`, entry);
                    await wakeSources?.(id);
                }
            }
        });
    };
    const decode = (definition: PluginCheckpointedEventSourceDefinitionV1) => {
        if (definition.eventRef.pluginId !== pluginId || definition.sourceContractVersion !== 1 || !isEventId(definition.eventRef.localId)) return null;
        const parsed = configSchema.safeParse(definition.sourceConfig);
        return parsed.success && (!parsed.data.previewChildren || definition.eventRef.localId === changedEvent) ? parsed.data : null;
    };
    const adopt = (definition: PluginCheckpointedEventSourceDefinitionV1, source: DeploymentReceiptEventSourceConfigV1) => {
        const event = definition.eventRef.localId as EventId;
        let state = states.get(definition.sourceInstanceId);
        if (!state || sourceId(state.config, state.event) !== sourceId(source, event)) {
            state = { config: source, event, fullRead: true, pending: new Map(), observing: new Set(), observations: null };
            states.set(definition.sourceInstanceId, state);
        }
        state.config = source;
        updateSourceSubscriptions();
        return state;
    };
    return {
        decode,
        async observe({ context, definition, source }) {
            const event = definition.eventRef.localId as EventId;
            const state = adopt(definition, source);
            if (state.observations === null) {
              const fullRead = state.fullRead;
              const pending = new Map<string, PendingReceipt>();
              try {
                const receipts: Receipt[] = [];
                const environments = new Map<string, Environment>();
                if (state.fullRead) {
                    const retained: Receipt[] = [];
                    const environmentIds: string[] = [];
                    let previewSelector: { projectSourceId: string; previewTemplateEnvironmentId: string; includeDeleted: true } | undefined;
                    if (source.previewChildren && source.environmentId !== undefined) {
                        const template = await context.services.actions.execute('deployments.environments.get', {
                            serverId: source.serverId, environmentId: source.environmentId,
                        }, { signal: context.signal });
                        if (!('ok' in template) || !template.ok) throw withActionFailureDiagnostic(new PluginError({ code: 'ok' in template ? template.error : 'deployment_unavailable' }), { phase: 'deployment.events.read', causeKind: 'native_failure', error: template });
                        environments.set(template.environment.id, template.environment);
                        previewSelector = { projectSourceId: template.environment.projectSourceId,
                            previewTemplateEnvironmentId: source.environmentId, includeDeleted: true };
                    }
                    if (source.environmentId === undefined || previewSelector) {
                        let cursor: string | undefined;
                        do {
                            const page = await context.services.actions.execute('deployments.environments.list', {
                                serverId: source.serverId, ...previewSelector, ...(cursor ? { cursor } : {}),
                            }, { signal: context.signal });
                            if (!('ok' in page) || !page.ok) throw withActionFailureDiagnostic(new PluginError({ code: 'ok' in page ? page.error : 'deployment_unavailable' }), { phase: 'deployment.events.read', causeKind: 'native_failure', error: page });
                            if (page.coverage === 'partial') throw withActionFailureDiagnostic(new PluginError({ code: 'deployment_unavailable' }), { phase: 'deployment.events.environments.list', causeKind: 'incomplete' });
                            for (const environment of page.items) environments.set(environment.id, environment);
                            environmentIds.push(...page.items.map(item => item.id)); cursor = page.nextCursor ?? undefined;
                        } while (cursor);
                    } else environmentIds.push(source.environmentId);
                    for (const environmentId of environmentIds) {
                        let cursor: string | undefined;
                        do {
                            const page = await context.services.actions.execute('deployments.receipts.list', {
                                serverId: source.serverId, environmentId, ...(event === changedEvent ? { limit: 1 } : {}),
                                ...(cursor ? { cursor } : {}),
                            }, { signal: context.signal });
                            if (!('ok' in page) || !page.ok) throw withActionFailureDiagnostic(new PluginError({ code: 'ok' in page ? page.error : 'deployment_unavailable', message: 'Deployment receipts are unavailable.' }), { phase: 'deployment.events.read', causeKind: 'native_failure', error: page });
                            retained.push(...page.items); cursor = event === changedEvent ? undefined : page.nextCursor ?? undefined;
                        } while (cursor);
                    }
                    // The adapter belongs to one authenticated Account. Share the
                    // receipt owner's facts only within the same Home/Environment;
                    // each source keeps its own projection and checkpoint.
                    const entries = retained.map(receipt => [receipt.id, { receipt: { ...receipt }, environmentId: receipt.environmentId,
                        ...(source.previewChildren ? { templateEnvironmentId: source.environmentId } : {}) }] as const);
                    for (const sibling of states.values()) {
                        if (!sibling.fullRead || sibling.config.serverId !== source.serverId
                            || sibling.config.environmentId !== source.environmentId
                            || sibling.config.previewChildren !== source.previewChildren
                            || (sibling.event === changedEvent) !== (event === changedEvent)) continue;
                        for (const [id, entry] of entries) if (!sibling.pending.has(id)) sibling.pending.set(id, entry);
                        sibling.observing.clear();
                        sibling.fullRead = false;
                    }
                }
                for (const id of state.observing) if (!state.pending.has(id)) state.pending.set(id, {});
                for (const [id, entry] of state.pending) pending.set(id, entry);
                for (const id of pending.keys()) state.pending.delete(id);
                const domainFacts = new Map<string, string>();
                for (const [pendingId, entry] of pending) {
                    const environmentId = entry.environmentId ?? source.environmentId;
                    if (environmentId === undefined) throw new PluginError({ code: 'deployment_unavailable', message: 'Receipt Environment is unavailable.' });
                    if (source.previewChildren && entry.templateEnvironmentId === undefined) {
                        const child = await context.services.actions.execute('deployments.environments.get', {
                            serverId: source.serverId, environmentId,
                        }, { signal: context.signal });
                        if (!('ok' in child) || !child.ok) throw withActionFailureDiagnostic(new PluginError({ code: 'ok' in child ? child.error : 'deployment_unavailable' }), { phase: 'deployment.events.read', causeKind: 'native_failure', error: child });
                        environments.set(child.environment.id, child.environment);
                        entry.templateEnvironmentId = child.environment.previewTemplateEnvironmentId ?? null;
                    }
                    if (source.previewChildren && entry.templateEnvironmentId !== source.environmentId) continue;
                    if (entry.receipt === undefined) {
                        const read = entry.latest
                            ? await context.services.actions.execute('deployments.receipts.list', {
                                serverId: source.serverId, environmentId, limit: 1,
                            }, { signal: context.signal })
                            : await context.services.actions.execute('deployments.receipts.get', {
                                serverId: source.serverId, environmentId, deploymentId: pendingId,
                            }, { signal: context.signal });
                        if (!('ok' in read) || !read.ok) {
                            if ('ok' in read && !read.ok && read.error === 'deployment_unavailable') {
                                entry.receipt = null;
                            } else throw withActionFailureDiagnostic(new PluginError({ code: 'ok' in read ? read.error : 'deployment_unavailable', message: 'Deployment receipt is unavailable.' }), { phase: 'deployment.events.read', causeKind: 'native_failure', error: read });
                        } else {
                            if ('items' in read) {
                                const latest = read.items[0];
                                entry.receipt = latest ? { ...latest } : null;
                            } else entry.receipt = projectReadReceipt(read);
                        }
                    }
                    if (entry.receipt === null) state.observing.delete(pendingId);
                    else {
                        if (event === changedEvent) {
                            if (entry.domains === undefined) {
                                const domains: string[] = [];
                                let cursor: string | undefined;
                                do {
                                    const page = await context.services.actions.execute('deployments.domains.list', {
                                        serverId: source.serverId, environmentId, ...(cursor ? { cursor } : {}),
                                    }, { signal: context.signal });
                                    if (!('ok' in page) || !page.ok) throw withActionFailureDiagnostic(new PluginError({ code: 'ok' in page ? page.error : 'deployment_unavailable' }), { phase: 'deployment.events.read', causeKind: 'native_failure', error: page });
                                    for (const domain of page.domains) domains.push(domain.id, String(domain.revision));
                                    cursor = page.nextCursor ?? undefined;
                                } while (cursor);
                                entry.domains = computeCanonicalDomainSeparatedDigest('happier.deployment.domain-revisions.v1', domains);
                            }
                            domainFacts.set(entry.receipt.id, entry.domains);
                        }
                        receipts.push(entry.receipt);
                    }
                }
                // Only the failed source drives finite platform observation. Its
                // sibling outcome sources consume the receipt owner's invalidation.
                if (source.targetLinkId && source.credentialPrincipal && source.environmentId !== undefined && event === DEPLOYMENT_FAILED_EVENT) {
                    for (const [index, receipt] of receipts.entries()) {
                        if (receipt.environmentId !== source.environmentId || receipt.targetLinkId !== source.targetLinkId
                            || receipt.operation === 'teardown' || !inProgressStates.has(receipt.state)) {
                            state.observing.delete(receipt.id);
                            continue;
                        }
                        state.observing.add(receipt.id);
                        const result = await context.services.actions.execute('deployments.receipts.observe', {
                            serverId: source.serverId, environmentId: source.environmentId, deploymentId: receipt.id,
                        }, { signal: context.signal });
                        if (!('ok' in result) || !result.ok) throw withActionFailureDiagnostic(new PluginError({ code: 'ok' in result ? result.error : 'deployment_unavailable' }), { phase: 'deployment.events.read', causeKind: 'native_failure', error: result });
                        if ('state' in result && !inProgressStates.has(result.state)) {
                            state.observing.delete(receipt.id);
                            const read = await context.services.actions.execute('deployments.receipts.get', {
                                serverId: source.serverId, environmentId: source.environmentId, deploymentId: receipt.id,
                            }, { signal: context.signal });
                            if (!('ok' in read) || !read.ok) throw withActionFailureDiagnostic(new PluginError({ code: 'ok' in read ? read.error : 'deployment_unavailable' }), { phase: 'deployment.events.read', causeKind: 'native_failure', error: read });
                            receipts[index] = projectReadReceipt(read);
                            pending.get(receipt.id)!.receipt = receipts[index];
                        }
                    }
                }
                const observations: PluginEventObservationV1[] = [];
                for (const receipt of receipts) {
                    const outcome = outcomes[event];
                    const completion = outcome.state === 'outcome_unknown' ? pending.get(receipt.id)?.completion : undefined;
                    const observedAt = completion?.occurredAt ?? receipt.settledAtMs;
                    if (!source.previewChildren && source.environmentId !== undefined && receipt.environmentId !== source.environmentId
                        || source.targetLinkId && (receipt.targetLinkId !== source.targetLinkId || receipt.operation === 'teardown')
                        || event === DEPLOYMENT_RECEIPT_EVENT_REFS_V1.succeeded.localId && receipt.operation === 'teardown'
                        || event !== changedEvent && (observedAt === undefined || observedAt < source.observingSince
                            || (completion?.state ?? receipt.state) !== outcome.state || outcome.operation !== null && receipt.operation !== outcome.operation)) continue;
                    let observedReceipt = receipt;
                    if (event === DEPLOYMENT_FAILED_EVENT && !Object.hasOwn(receipt, 'failureSummary')) {
                        const result = await context.services.actions.execute('deployments.receipts.get', {
                            serverId: source.serverId, environmentId: receipt.environmentId, deploymentId: receipt.id,
                        }, { signal: context.signal });
                        if (!('ok' in result) || !result.ok) throw withActionFailureDiagnostic(new PluginError({
                            code: 'ok' in result ? result.error : 'deployment_unavailable',
                        }), { phase: 'deployment.events.read', causeKind: 'native_failure', error: result });
                        observedReceipt = projectReadReceipt(result, receipt);
                    }
                    const environment = receipt.environment ?? environments.get(receipt.environmentId)
                        ?? await readReceiptEnvironment(context, source.serverId, receipt.environmentId);
                    environments.set(environment.id, environment);
                    // The invalidation also delivers native completion. Reuse this
                    // opened header there instead of reading the same Environment again.
                    receipt.environment = environment;
                    observations.push(projectReceiptObservation({ receipt: observedReceipt, environment, event, serverId: source.serverId,
                        sourceInstanceId: definition.sourceInstanceId, observationReceivedAt: now(),
                        domainFingerprint: domainFacts.get(receipt.id), ...(completion ? { completion } : {}) }));
                }
                state.observations = observations;
              } catch (error) {
                if (fullRead) state.fullRead = true;
                for (const [id, entry] of pending) if (entry.completion?.state === 'outcome_unknown' && outcomes[event].state === 'outcome_unknown'
                    || !fullRead && !state.pending.has(id)) {
                    state.pending.set(id, {
                        environmentId: entry.environmentId, latest: entry.latest, templateEnvironmentId: entry.templateEnvironmentId,
                        completion: entry.completion,
                    });
                }
                throw error;
              }
            }
            return { observations: state.observations, checkpoint: state, complete: true,
                nextEligibleAt: state.pending.size || state.fullRead ? now() : pendingEligibility(state, now()),
                ...(state.observing.size > 0 && source.periodMs === undefined
                    ? { status: { state: 'attention' as const, code: 'sourceContractIncompatible' as const } } : {}) };
        },
        async save({ checkpoint }) { checkpoint.observations = null; },
        retryAt({ definition, now: time }) {
            const state = definition && states.get(definition.sourceInstanceId);
            return state ? pendingEligibility(state, time) : null;
        },
        async retire({ context, definitions }) {
            const current = new Set<string>();
            for (const definition of definitions) {
                if (definition.observationTransport.kind !== 'checkpointedPull') continue;
                const assigned = definition.observationTransport.watcherMaterializationRef;
                if (!context.materialization || !arePluginMachineMaterializationRefsEqual(context.materialization, assigned)) continue;
                const source = decode(definition);
                if (source) { adopt(definition, source); current.add(definition.sourceInstanceId); }
            }
            for (const key of states.keys()) if (!current.has(key)) states.delete(key);
            updateSourceSubscriptions();
            return { complete: true };
        },
        subscribeWake(wake) {
            wakeSources = wake;
            updateSourceSubscriptions();
            const receipts = host.subscribe({ eventId: '@happier/deployment/receipt-invalidated', scope: { kind: 'account' } }, async event => {
                const { completion, ...address } = event.payload;
                const entry: PendingReceipt = { environmentId: address.environmentId, completion };
                for (const [id, state] of states) if (state.config.serverId === event.payload.serverId
                    && (state.config.environmentId === undefined || state.config.environmentId === event.payload.environmentId || state.config.previewChildren)) {
                    const pending = state.pending.get(address.deploymentId);
                    if (outcomes[state.event].state !== 'outcome_unknown' || pending?.completion?.state !== 'outcome_unknown') {
                        state.pending.set(address.deploymentId, entry);
                    }
                    await wake(id);
                }
                if (!completionContext || completion === null) return;
                // A woken source may already have opened this invalidated receipt for the same Account and Environment.
                let nativeReceipt = entry.receipt;
                if (!nativeReceipt) {
                    const read = await completionContext.services.actions.execute('deployments.receipts.get', address,
                        { signal: completionContext.signal });
                    if (!('ok' in read) || !read.ok) throw withActionFailureDiagnostic(new PluginError({
                        code: 'ok' in read ? read.error : 'deployment_unavailable',
                    }), { phase: 'deployment.events.read', causeKind: 'native_failure', error: read });
                    nativeReceipt = projectReadReceipt(read);
                }
                if (nativeReceipt.operation !== 'deploy' || (completion === undefined && nativeReceipt.settledAtMs === undefined)) return;
                const environment = nativeReceipt.environment
                    ?? await readReceiptEnvironment(completionContext, event.payload.serverId, nativeReceipt.environmentId);
                for (const candidate of Object.keys(outcomes) as EventId[]) {
                    if (!outcomes[candidate].completesActionIds || outcomes[candidate].state !== (completion?.state ?? nativeReceipt.state)
                        || outcomes[candidate].operation !== null) continue;
                    await admitNativeActionCompletionObservation(completionContext, projectReceiptObservation({
                        receipt: nativeReceipt, environment, event: candidate, serverId: address.serverId, observationReceivedAt: now(), ...(completion ? { completion } : {}),
                        sourceInstanceId: `deployment:${computeCanonicalDomainSeparatedDigest('happier.deployment.completion-source.v1',
                            [event.payload.serverId, nativeReceipt.environmentId, candidate])}`,
                    }));
                }
            });
            return { dispose() { receipts.dispose(); wakeSources = undefined; updateSourceSubscriptions(); } };
        },
    };
}
export async function runDeploymentReceiptEventObserver(context: BackgroundServiceContext): Promise<void> {
    await runCheckpointedPluginEventObserverV1({ context, source: createDeploymentReceiptEventSourceAdapter(context.services.events.host, Date.now, context) });
}
export const deploymentEventBackgroundServices = [{ declaration: { id: 'deployment-receipt-observer',
    title: 'Deployment receipt Events', placement: 'daemon' as const }, runner: runDeploymentReceiptEventObserver }];
