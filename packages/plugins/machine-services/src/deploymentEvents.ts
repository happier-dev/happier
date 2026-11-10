import { arePluginMachineMaterializationRefsEqual, computeCanonicalDomainSeparatedDigest, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1, DEPLOYMENT_RECEIPT_CHANGED_EVENT_REF_V1, readDeploymentAccountChangeV1,
    DeploymentReceiptChangedEventV1ProtocolSchema as changedSchema,
    deploymentInProgressStates, DeploymentReceiptEventSourceConfigV1ProtocolSchema as configSchema,
    DeploymentReceiptEventSetupV1ProtocolSchema as setupSchema,
    DeploymentFailedEventV1ProtocolSchema as failedSchema, DeploymentRollbackCompletedEventV1ProtocolSchema as rollbackSchema,
    DeploymentReceiptOutcomeEventV1ProtocolSchema as outcomeSchema,
    createPluginEventAutomationSetupResultV1JsonSchema,
    type DeploymentReceiptEventSourceConfigV1, type PluginEventObservationV1 } from '@happier-dev/plugin-sdk/events';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext,
    type PluginCheckpointedEventSourceAdapterV1, type PluginCheckpointedEventSourceDefinitionV1 } from '@happier-dev/plugin-sdk/background-services';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

const pluginId = DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.pluginId;
export const DEPLOYMENT_FAILED_EVENT = DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.localId;
const changedEvent = DEPLOYMENT_RECEIPT_CHANGED_EVENT_REF_V1.localId;
export const ROLLBACK_COMPLETED_EVENT = 'rollback-completed';
type ReceiptRead = Extract<PluginActionResultById['deployments.receipts.get'], { ok: true }>;
type Receipt = ReceiptRead['deployment'] & Pick<ReceiptRead, 'failureSummary'>;
const outcomes = {
    [changedEvent]: { state: null, operation: null, schema: changedSchema, key: 'deploymentReceiptChanged',
        title: 'Deployment receipt changed', description: 'The current deployment receipt or its serving Domain changed.' },
    [DEPLOYMENT_FAILED_EVENT]: { state: 'failed', operation: null, schema: failedSchema, key: 'deploymentFailed',
        title: 'Deployment failed', description: 'A deployment receipt settled as failed, with its recorded failure phase.' },
    [ROLLBACK_COMPLETED_EVENT]: { state: 'succeeded', operation: 'rollback', schema: rollbackSchema, key: 'rollbackCompleted',
        title: 'Rollback completed', description: 'A rollback receipt settled successfully.' },
    [DEPLOYMENT_RECEIPT_EVENT_REFS_V1.succeeded.localId]: { state: 'succeeded', operation: null, schema: outcomeSchema, key: 'deploymentSucceeded',
        title: 'Deployment succeeded', description: 'A deployment receipt settled successfully.' },
    'promotion-completed': { state: 'succeeded', operation: 'promote', schema: outcomeSchema, key: 'promotionCompleted',
        title: 'Promotion completed', description: 'A promotion receipt settled successfully.' },
    'deployment-cancelled': { state: 'cancelled', operation: null, schema: outcomeSchema, key: 'deploymentCancelled',
        title: 'Deployment cancelled', description: 'A deployment receipt settled as cancelled.' },
    'deployment-outcome-unknown': { state: 'outcome_unknown', operation: null, schema: outcomeSchema, key: 'deploymentOutcomeUnknown',
        title: 'Deployment outcome unknown', description: 'A deployment receipt recorded an unknown outcome.' },
} as const;
type EventId = keyof typeof outcomes;
const isEventId = (id: string): id is EventId => Object.hasOwn(outcomes, id);
const sourceId = (config: DeploymentReceiptEventSourceConfigV1, event: EventId) =>
    `deployment:${computeCanonicalDomainSeparatedDigest('happier.deployment.event-source.v1', [config.serverId, config.environmentId, event, String(config.observingSince),
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
        if (scope.targetLinkId) {
            const read = await context.services.actions.execute('deployments.observation.get', {
                serverId: scope.serverId, environmentId: scope.environmentId, targetLinkId: scope.targetLinkId,
            }, { signal: context.signal });
            if (!read.ok) throw new PluginError({ code: read.error });
            if (read.environment.id !== scope.environmentId || read.environment.runtimeTargetLinkId !== scope.targetLinkId
                || read.targetLink.id !== scope.targetLinkId || read.targetLink.role !== 'runtime' || read.targetLink.source.kind !== 'plugin') {
                throw new PluginError({ code: 'deployment_target_unavailable' });
            }
            credentialPrincipal = read.credentialPrincipal;
        } else {
            const read = await context.services.actions.execute('deployments.environments.get', {
                serverId: scope.serverId, environmentId: scope.environmentId,
            }, { signal: context.signal });
            if (!('ok' in read) || !read.ok || read.environment.id !== scope.environmentId) throw new PluginError({
                code: 'ok' in read && !read.ok ? read.error : 'deployment_unavailable', message: 'The selected Environment is unavailable.',
            });
        }
        const config = configSchema.parse({ ...scope, observingSince: context.invokedAtMs,
            ...(credentialPrincipal ? { credentialPrincipal } : {}) });
        return { v: 1 as const, sourceInstanceId: sourceId(config, event), sourceContractVersion: 1,
            sourceConfig: config, displayLabel: config.environmentId };
    },
});
export const deploymentEventActions = Object.fromEntries((Object.keys(outcomes) as EventId[])
    .map(id => [`${id}/setup`, setupAction(id)]));
const event = (id: EventId) => {
    const { title, schema: payloadSchema, key, description } = outcomes[id];
    return { declaration: {
    kind: 'event' as const, title: { key: `machineServices.events.${key}.title`, fallback: title }, payloadSchema: payloadSchema.jsonSchema,
    description: { key: `machineServices.events.${key}.description`, fallback: description },
    automation: { v: 1 as const, eligible: true as const, source: { sourceContractVersion: 1,
        supportedObservationTransports: ['checkpointedPull' as const], sourceConfigSchema: configSchema.jsonSchema,
        setupActionRef: { pluginId, localId: `${id}/setup` } } },
} };
};
export const deploymentEvents = Object.fromEntries((Object.keys(outcomes) as EventId[]).map(id => [id, event(id)]));

type PendingReceipt = { receipt?: Receipt | null; environmentId?: string; latest?: true;
    templateEnvironmentId?: string | null; domains?: string };
type State = { config: DeploymentReceiptEventSourceConfigV1; event: EventId; fullRead: boolean;
    pending: Map<string, PendingReceipt>; observing: Set<string>; observations: PluginEventObservationV1[] | null };
const inProgressStates = new Set(deploymentInProgressStates());
function pendingEligibility(state: State, time: number): number | null {
    return state.observing.size > 0 && state.config.periodMs !== undefined
        ? Math.min(Number.MAX_SAFE_INTEGER, time + state.config.periodMs) : null;
}
/** Receipts own durable facts; this adapter holds only the current finite attempt.
 * Adoption/reconnect replays retained receipts through the existing occurrence dedupe. */
export function createDeploymentReceiptEventSourceAdapter(host: BackgroundServiceContext['services']['events']['host'],
    now: () => number = Date.now): PluginCheckpointedEventSourceAdapterV1<DeploymentReceiptEventSourceConfigV1, State> {
    const states = new Map<string, State>();
    let accountChanges: { dispose(): void } | undefined;
    let wakeSources: Parameters<NonNullable<PluginCheckpointedEventSourceAdapterV1<DeploymentReceiptEventSourceConfigV1, State>['subscribeWake']>>[0] | undefined;
    const updateAccountSubscription = () => {
        const needed = [...states.values()].some(state => state.event === changedEvent);
        if (!needed) { accountChanges?.dispose(); accountChanges = undefined; }
        else if (!accountChanges && wakeSources) accountChanges = host.subscribe({
            eventId: '@happier/account/entities-invalidated', scope: { kind: 'account' },
        }, async event => {
            for (const entityId of event.payload.entityIds) {
                const change = readDeploymentAccountChangeV1({ kind: 'account', entityId });
                if (!change || change.deploymentId || change.activityChanged) continue;
                const entries = new Map<string, PendingReceipt>();
                for (const [id, state] of states) {
                    if (state.event !== changedEvent || !state.config.previewChildren && state.config.environmentId !== change.environmentId) continue;
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
        updateAccountSubscription();
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
                if (state.fullRead) {
                    const retained: Receipt[] = [];
                    const environmentIds: string[] = [];
                    if (source.previewChildren) {
                        const template = await context.services.actions.execute('deployments.environments.get', {
                            serverId: source.serverId, environmentId: source.environmentId,
                        }, { signal: context.signal });
                        if (!('ok' in template) || !template.ok) throw new PluginError({ code: 'ok' in template ? template.error : 'deployment_unavailable' });
                        let cursor: string | undefined;
                        do {
                            const page = await context.services.actions.execute('deployments.environments.list', {
                                serverId: source.serverId, projectSourceId: template.environment.projectSourceId,
                                previewTemplateEnvironmentId: source.environmentId, includeDeleted: true, ...(cursor ? { cursor } : {}),
                            }, { signal: context.signal });
                            if (!('ok' in page) || !page.ok) throw new PluginError({ code: 'ok' in page ? page.error : 'deployment_unavailable' });
                            if (page.coverage === 'partial') throw new PluginError({ code: 'deployment_unavailable' });
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
                            if (!('ok' in page) || !page.ok) throw new PluginError({ code: 'ok' in page ? page.error : 'deployment_unavailable', message: 'Deployment receipts are unavailable.' });
                            retained.push(...page.items); cursor = event === changedEvent ? undefined : page.nextCursor ?? undefined;
                        } while (cursor);
                    }
                    // The adapter belongs to one authenticated Account. Share the
                    // receipt owner's facts only within the same Home/Environment;
                    // each source keeps its own projection and checkpoint.
                    const entries = retained.map(receipt => [receipt.id, { receipt, environmentId: receipt.environmentId,
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
                    if (source.previewChildren && entry.templateEnvironmentId === undefined) {
                        const child = await context.services.actions.execute('deployments.environments.get', {
                            serverId: source.serverId, environmentId,
                        }, { signal: context.signal });
                        if (!('ok' in child) || !child.ok) throw new PluginError({ code: 'ok' in child ? child.error : 'deployment_unavailable' });
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
                            } else throw new PluginError({ code: 'ok' in read ? read.error : 'deployment_unavailable', message: 'Deployment receipt is unavailable.' });
                        } else {
                            entry.receipt = 'items' in read ? read.items[0] ?? null : { ...read.deployment, failureSummary: read.failureSummary };
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
                                    if (!('ok' in page) || !page.ok) throw new PluginError({ code: 'ok' in page ? page.error : 'deployment_unavailable' });
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
                if (source.targetLinkId && event === DEPLOYMENT_FAILED_EVENT) {
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
                        if (!result.ok) throw new PluginError({ code: result.error });
                        if ('state' in result && !inProgressStates.has(result.state)) {
                            state.observing.delete(receipt.id);
                            const read = await context.services.actions.execute('deployments.receipts.get', {
                                serverId: source.serverId, environmentId: source.environmentId, deploymentId: receipt.id,
                            }, { signal: context.signal });
                            if (!read.ok) throw new PluginError({ code: read.error });
                            receipts[index] = { ...read.deployment, failureSummary: read.failureSummary };
                            pending.get(receipt.id)!.receipt = receipts[index];
                        }
                    }
                }
                const observations: PluginEventObservationV1[] = [];
                for (const receipt of receipts) {
                    const outcome = outcomes[event];
                    if (!source.previewChildren && receipt.environmentId !== source.environmentId
                        || source.targetLinkId && (receipt.targetLinkId !== source.targetLinkId || receipt.operation === 'teardown')
                        || event === DEPLOYMENT_RECEIPT_EVENT_REFS_V1.succeeded.localId && receipt.operation === 'teardown'
                        || event !== changedEvent && (receipt.settledAtMs === undefined || receipt.settledAtMs < source.observingSince
                            || receipt.state !== outcome.state || outcome.operation !== null && receipt.operation !== outcome.operation)) continue;
                    const observedAt = receipt.settledAtMs ?? receipt.startedAtMs ?? receipt.requestedAtMs;
                    const identity = { environmentId: receipt.environmentId, deploymentId: receipt.id, targetLinkId: receipt.targetLinkId,
                        receiptRevision: receipt.revision, observedAt };
                    let payload;
                    if (event === DEPLOYMENT_FAILED_EVENT) {
                        const result = receipt.failureSummary === undefined ? await context.services.actions.execute('deployments.receipts.get', {
                            serverId: source.serverId, environmentId: receipt.environmentId, deploymentId: receipt.id,
                        }, { signal: context.signal }) : { ok: true as const, failureSummary: receipt.failureSummary };
                        if (!result.ok) throw new PluginError({ code: result.error });
                        if (result.failureSummary === undefined) throw new PluginError({
                            code: 'deployment_content_unavailable', message: 'Deployment failure detail is unavailable.',
                        });
                        payload = failedSchema.parse({ ...identity, operation: receipt.operation, state: 'failed',
                            phase: result.failureSummary?.phase ?? null, failureCode: result.failureSummary?.code ?? null });
                    } else payload = outcome.schema.parse({ ...identity, operation: receipt.operation, state: receipt.state });
                    observations.push({ eventRef: { pluginId, localId: event }, sourceInstanceId: definition.sourceInstanceId,
                        sourceContractVersion: definition.sourceContractVersion,
                        occurrenceId: computeCanonicalDomainSeparatedDigest('happier.deployment.receipt-event.v1',
                            [source.serverId, receipt.environmentId, receipt.id, event, String(observedAt),
                                ...(event === changedEvent ? [String(receipt.revision), domainFacts.get(receipt.id)!] : [])]),
                        occurredAt: observedAt, observationReceivedAt: now(), observedDelta: 1, payload });
                }
                state.observations = observations;
              } catch (error) {
                if (fullRead) state.fullRead = true;
                else for (const [id, entry] of pending) if (!state.pending.has(id)) state.pending.set(id, {
                    environmentId: entry.environmentId, latest: entry.latest, templateEnvironmentId: entry.templateEnvironmentId,
                });
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
                const assigned = definition.observationTransport.kind === 'checkpointedPull'
                    ? definition.observationTransport.watcherMaterializationRef : definition.observationTransport.consumerMaterializationRef;
                if (!context.materialization || !arePluginMachineMaterializationRefsEqual(context.materialization, assigned)) continue;
                const source = decode(definition);
                if (source) { adopt(definition, source); current.add(definition.sourceInstanceId); }
            }
            for (const key of states.keys()) if (!current.has(key)) states.delete(key);
            updateAccountSubscription();
            return { complete: true };
        },
        subscribeWake(wake) {
            wakeSources = wake;
            updateAccountSubscription();
            const receipts = host.subscribe({ eventId: '@happier/deployment/receipt-invalidated', scope: { kind: 'account' } }, async event => {
                const entries = new Map<string, PendingReceipt>();
                for (const [id, state] of states) if (state.config.environmentId === event.payload.environmentId || state.config.previewChildren) {
                    const entry = entries.get(state.config.serverId) ?? { environmentId: event.payload.environmentId };
                    entries.set(state.config.serverId, entry);
                    state.pending.set(event.payload.deploymentId, entry); await wake(id);
                }
            });
            const reconnect = host.subscribe({ eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' } }, async event => {
                if (event.payload.reason !== 'reconnect') return;
                for (const state of states.values()) state.fullRead = true;
                await wake();
            });
            return { dispose() { receipts.dispose(); reconnect.dispose(); accountChanges?.dispose(); accountChanges = undefined; wakeSources = undefined; } };
        },
    };
}
export async function runDeploymentReceiptEventObserver(context: BackgroundServiceContext): Promise<void> {
    await runCheckpointedPluginEventObserverV1({ context, source: createDeploymentReceiptEventSourceAdapter(context.services.events.host) });
}
export const deploymentEventBackgroundServices = [{ declaration: { id: 'deployment-receipt-observer',
    title: 'Deployment receipt Events', placement: 'daemon' as const }, runner: runDeploymentReceiptEventObserver }];
