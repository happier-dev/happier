import { computeCanonicalDomainSeparatedDigest, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1, deploymentInProgressStates, DeploymentReceiptEventSourceConfigV1ProtocolSchema as configSchema,
    DeploymentReceiptEventSetupV1ProtocolSchema as setupSchema,
    DeploymentFailedEventV1ProtocolSchema as failedSchema, DeploymentRollbackCompletedEventV1ProtocolSchema as rollbackSchema,
    DeploymentReceiptOutcomeEventV1ProtocolSchema as outcomeSchema,
    createPluginEventAutomationSetupResultV1JsonSchema,
    type DeploymentReceiptEventSourceConfigV1, type PluginEventObservationV1 } from '@happier-dev/plugin-sdk/events';
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext,
    type PluginCheckpointedEventSourceAdapterV1 } from '@happier-dev/plugin-sdk/background-services';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

const pluginId = DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.pluginId;
export const DEPLOYMENT_FAILED_EVENT = DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.localId;
export const ROLLBACK_COMPLETED_EVENT = 'rollback-completed';
type ReceiptRead = Extract<PluginActionResultById['deployments.receipts.get'], { ok: true }>;
type Receipt = ReceiptRead['deployment'] & Pick<ReceiptRead, 'failureSummary'>;
const outcomes = {
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
        ...(config.targetLinkId ? [config.targetLinkId] : [])])}`;

const setupAction = (event: EventId) => ({
    title: 'Choose deployment Environment', execution: { target: 'daemon' as const }, scopes: ['global', 'machine'] as const,
    surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'] as const, dangerLevel: 'safe' as const, readOnly: true,
    inputSchema: setupSchema,
    resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, configSchema.jsonSchema),
    async run(input: unknown, context: PluginInvocationContext) {
        const scope = setupSchema.parse(input);
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

type State = { config: DeploymentReceiptEventSourceConfigV1; event: EventId; fullRead: boolean;
    pending: Set<string>; observing: Set<string>; observations: PluginEventObservationV1[] | null };
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
    return {
        decode(definition) {
            if (definition.eventRef.pluginId !== pluginId || definition.sourceContractVersion !== 1 || !isEventId(definition.eventRef.localId)) return null;
            const parsed = configSchema.safeParse(definition.sourceConfig);
            return parsed.success ? parsed.data : null;
        },
        async observe({ context, definition, source }) {
            const event = definition.eventRef.localId as EventId;
            let state = states.get(definition.sourceInstanceId);
            if (!state || sourceId(state.config, state.event) !== sourceId(source, event)) {
                state = { config: source, event, fullRead: true, pending: new Set(), observing: new Set(), observations: null };
                states.set(definition.sourceInstanceId, state); }
            state.config = source;
            if (state.observations === null) {
              const fullRead = state.fullRead;
              const pending = new Set([...state.pending, ...state.observing]);
              try {
                const receipts: Receipt[] = [];
                if (state.fullRead) {
                    let cursor: string | undefined;
                    do {
                        const page = await context.services.actions.execute('deployments.receipts.list', {
                            serverId: source.serverId, environmentId: source.environmentId, ...(cursor ? { cursor } : {}),
                        }, { signal: context.signal });
                        if (!('ok' in page) || !page.ok) throw new PluginError({ code: 'ok' in page ? page.error : 'deployment_unavailable', message: 'Deployment receipts are unavailable.' });
                        receipts.push(...page.items); cursor = page.nextCursor ?? undefined;
                    } while (cursor);
                    state.fullRead = false;
                } else {
                    for (const id of pending) state.pending.delete(id);
                    for (const deploymentId of pending) {
                        const read = await context.services.actions.execute('deployments.receipts.get', {
                            serverId: source.serverId, environmentId: source.environmentId, deploymentId,
                        }, { signal: context.signal });
                        if (!('ok' in read) || !read.ok) {
                            if ('ok' in read && !read.ok && read.error === 'deployment_unavailable') {
                                state.observing.delete(deploymentId);
                                continue;
                            }
                            throw new PluginError({ code: 'ok' in read ? read.error : 'deployment_unavailable', message: 'Deployment receipt is unavailable.' });
                        }
                        receipts.push({ ...read.deployment, failureSummary: read.failureSummary });
                    }
                }
                // Only the failed source drives finite platform observation. Its
                // sibling outcome sources consume the receipt owner's invalidation.
                if (source.targetLinkId && event === DEPLOYMENT_FAILED_EVENT) {
                    if (fullRead) state.observing.clear();
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
                        }
                    }
                }
                const observations: PluginEventObservationV1[] = [];
                for (const receipt of receipts) {
                    const outcome = outcomes[event];
                    if (receipt.environmentId !== source.environmentId
                        || source.targetLinkId && (receipt.targetLinkId !== source.targetLinkId || receipt.operation === 'teardown')
                        || event === DEPLOYMENT_RECEIPT_EVENT_REFS_V1.succeeded.localId && receipt.operation === 'teardown'
                        || receipt.settledAtMs === undefined || receipt.settledAtMs < source.observingSince
                        || receipt.state !== outcome.state || outcome.operation !== null && receipt.operation !== outcome.operation) continue;
                    const identity = { environmentId: receipt.environmentId, deploymentId: receipt.id, targetLinkId: receipt.targetLinkId,
                        receiptRevision: receipt.revision, observedAt: receipt.settledAtMs };
                    let payload;
                    if (event === DEPLOYMENT_FAILED_EVENT) {
                        const result = receipt.failureSummary === undefined ? await context.services.actions.execute('deployments.receipts.get', {
                            serverId: source.serverId, environmentId: source.environmentId, deploymentId: receipt.id,
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
                            [source.serverId, receipt.environmentId, receipt.id, event, String(receipt.settledAtMs)]),
                        occurredAt: receipt.settledAtMs, observationReceivedAt: now(), observedDelta: 1, payload });
                }
                state.observations = observations;
              } catch (error) {
                if (fullRead) state.fullRead = true;
                else for (const id of pending) state.pending.add(id);
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
        async retire({ definitions }) {
            const current = new Set(definitions.map(definition => definition.sourceInstanceId));
            for (const key of states.keys()) if (!current.has(key)) states.delete(key);
            return { complete: true };
        },
        subscribeWake(wake) {
            const receipts = host.subscribe({ eventId: '@happier/deployment/receipt-invalidated', scope: { kind: 'account' } }, async event => {
                for (const [id, state] of states) if (state.config.environmentId === event.payload.environmentId) {
                    state.pending.add(event.payload.deploymentId); await wake(id);
                }
            });
            const reconnect = host.subscribe({ eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' } }, async event => {
                if (event.payload.reason !== 'reconnect') return;
                for (const state of states.values()) state.fullRead = true;
                await wake();
            });
            return { dispose() { receipts.dispose(); reconnect.dispose(); } };
        },
    };
}
export async function runDeploymentReceiptEventObserver(context: BackgroundServiceContext): Promise<void> {
    await runCheckpointedPluginEventObserverV1({ context, source: createDeploymentReceiptEventSourceAdapter(context.services.events.host) });
}
export const deploymentEventBackgroundServices = [{ declaration: { id: 'deployment-receipt-observer',
    title: 'Deployment receipt Events', placement: 'daemon' as const }, runner: runDeploymentReceiptEventObserver }];
