import {
    PluginWebhookEndpointEnsureInputV1Schema,
    PluginWebhookEndpointEnsureResultV1Schema,
    PluginWebhookEndpointReadInputV1Schema,
    PluginWebhookEndpointReadResultV1Schema,
    computeCanonicalDomainSeparatedDigest,
    type DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    type PluginWebhookEndpointEnsureResultV1,
    type PluginWebhookEndpointReadResultV1,
    type PluginWebhookEndpointSetupV1,
} from '@happier-dev/protocol';

import {
    type PluginWebhookEndpointUiActionExecutor,
} from '@/sync/api/plugins/webhooks/endpointActions';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { FreshPluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

const executePluginWebhookEndpointAction = createFrontDoorUiActionExecutor();

/**
 * The one setup arm an authoring client can complete on its own: the server
 * mints the shared secret and hands it back once, and the user configures the
 * provider with it. The shared-installation arm needs an installation
 * authorization this composer cannot obtain, so it is deliberately absent.
 *
 * Both the ensure call and the Automation writer input read this same
 * constant, so the endpoint and the trigger can never be ensured with one
 * setup identity and persisted with another.
 */
export const PLUGIN_EVENT_AUTOMATION_WEBHOOK_ENDPOINT_SETUP_V1 = Object.freeze({
    kind: 'accountEndpointV1',
    credential: 'serverGenerated',
} as const) satisfies PluginWebhookEndpointSetupV1;

export type PluginEventAutomationWebhookEndpoint = Readonly<{
    webhookEndpointId: string;
    /** The exact URL the user configures in the provider. */
    publicUrl: string;
    readiness: PluginWebhookEndpointEnsureResultV1['readiness'];
    /**
     * Disclosed exactly once by the server. A rejoined ensure returns
     * `credentialDisclosureLost` and no secret; the webhook administration
     * screen owns re-disclosure through credential rotation.
     */
    oneTimeGeneratedSecret: string | null;
}>;

/**
 * `available` states only that the Account endpoint and its route exist and
 * are enabled. It is deliberately not called `ready`: `endpoint.readiness`
 * remains the single authority on whether the provider still has to be
 * configured with the disclosed URL and secret. The server owns that decision
 * in `projectPluginWebhookEndpointReadinessV1`, which reports `ready` only
 * after its durable `providerConfirmedAt` fact — written when the binding
 * first admits a signature-verified provider delivery — exists. Every consumer
 * reads that field rather than treating a returned endpoint as a working
 * delivery path.
 */
export type PluginEventAutomationWebhookEndpointResult =
    | Readonly<{ kind: 'available'; endpoint: PluginEventAutomationWebhookEndpoint }>
    | Readonly<{ kind: 'unavailable' }>;

/**
 * Folds a reread of the same endpoint into the value the composer is already
 * showing.
 *
 * A read deliberately never re-discloses the one-time generated secret, so the
 * refreshed record carries `null` there. Replacing the shown endpoint with it
 * would destroy the only copy of a credential the server will not repeat,
 * which is why this owner — the one that defines the value — merges only the
 * facts a reread can actually re-establish. A reread of a different endpoint
 * belongs to a setup this value no longer represents and is ignored.
 */
export function applyRefreshedPluginEventAutomationWebhookEndpoint(
    current: PluginEventAutomationWebhookEndpoint | null,
    refreshed: PluginEventAutomationWebhookEndpoint,
): PluginEventAutomationWebhookEndpoint | null {
    if (!current || current.webhookEndpointId !== refreshed.webhookEndpointId) return current;
    return Object.freeze({
        ...current,
        publicUrl: refreshed.publicUrl,
        readiness: refreshed.readiness,
    });
}

/**
 * The persisted endpoint facts an Event editor needs to rebuild a durable-push
 * trigger: the exact target materialization the current writer must name again, and
 * the public URL the user configured. They stay owned by the canonical webhook
 * endpoint store, so no Automation projection duplicates them.
 */
export type PluginEventAutomationWebhookEndpointBinding = Readonly<{
    endpoint: PluginEventAutomationWebhookEndpoint;
    targetMaterialization: Readonly<{
        machineId: string;
        materializationId: string;
        pluginId: string;
    }>;
    sourceInstanceId: string;
}>;

export type PluginEventAutomationWebhookEndpointBindingResult =
    | Readonly<{ kind: 'available'; binding: PluginEventAutomationWebhookEndpointBinding }>
    | Readonly<{ kind: 'unavailable' }>;

/**
 * One ensure request per (Event contribution, endpoint materialization,
 * routing source instance). The key is derived rather than random so that
 * repeating setup rejoins the existing endpoint instead of accumulating a new
 * route and credential for the same source on every press.
 */
function ensureIdempotencyKey(params: Readonly<{
    webhookContribution: Readonly<{ pluginId: string; localId: string }>;
    materializationRef: Readonly<{ machineId: string; materializationId: string; pluginId: string }>;
    sourceInstanceId: string;
}>): string {
    return `whep.${computeCanonicalDomainSeparatedDigest('happier.automation.webhookEndpoint.ensure.v1', [
        params.webhookContribution.pluginId,
        params.webhookContribution.localId,
        params.materializationRef.machineId,
        params.materializationRef.materializationId,
        params.materializationRef.pluginId,
        params.sourceInstanceId,
    ])}`;
}

/**
 * Ensures the Account webhook endpoint that a durable-push Automation trigger
 * will reference. The declared webhook contribution comes from the current
 * Event declaration and the target comes from the already-selected plugin
 * execution origin; this adapter chooses neither.
 */
export async function ensurePluginEventAutomationWebhookEndpoint(params: Readonly<{
    eligibleEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1;
    origin: FreshPluginMachineExecutionOriginV1;
    sourceInstanceId: string;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal?: AbortSignal;
    executeAction?: PluginWebhookEndpointUiActionExecutor;
}>): Promise<PluginEventAutomationWebhookEndpointResult> {
    const webhookContribution = params.eligibleEvent.event.automation.source.webhookContributionRef;
    const materializationRef = params.origin.origin.materializationRef;
    // Read through a call so the post-await recheck below observes the live
    // signal instead of the state narrowed by this first guard.
    const aborted = (): boolean => params.signal?.aborted === true;
    if (
        webhookContribution === undefined
        || webhookContribution.pluginId !== params.eligibleEvent.event.identity.pluginId
        || materializationRef.pluginId !== params.eligibleEvent.event.identity.pluginId
        || aborted()
        || !params.accountLifetime.isCurrent()
    ) {
        return { kind: 'unavailable' };
    }
    const input = PluginWebhookEndpointEnsureInputV1Schema.safeParse({
        webhookContribution,
        targetMaterialization: materializationRef,
        sourceInstanceId: params.sourceInstanceId,
        setup: PLUGIN_EVENT_AUTOMATION_WEBHOOK_ENDPOINT_SETUP_V1,
        idempotencyKey: ensureIdempotencyKey({
            webhookContribution,
            materializationRef,
            sourceInstanceId: params.sourceInstanceId,
        }),
    });
    if (!input.success) return { kind: 'unavailable' };

    const execute = params.executeAction ?? executePluginWebhookEndpointAction;
    let result: PluginWebhookEndpointEnsureResultV1;
    try {
        result = PluginWebhookEndpointEnsureResultV1Schema.parse(
            await execute('plugin.webhook.endpoint.ensure', input.data),
        );
    } catch {
        return { kind: 'unavailable' };
    }
    if (aborted() || !params.accountLifetime.isCurrent()) {
        return { kind: 'unavailable' };
    }
    if (result.readiness === 'targetUnavailable' || result.readiness === 'routeUnavailable') {
        return { kind: 'unavailable' };
    }
    return {
        kind: 'available',
        endpoint: Object.freeze({
            webhookEndpointId: result.webhookEndpointId,
            publicUrl: result.publicUrl,
            readiness: result.readiness,
            oneTimeGeneratedSecret: result.oneTimeGeneratedSecret ?? null,
        }),
    };
}

/**
 * Re-reads an already-ensured endpoint through its canonical owner so an Event
 * edit can name the exact endpoint materialization again and re-disclose the
 * public URL. It never re-ensures, never mints a credential, and never accepts
 * an endpoint whose routing, plugin, or routing source instance disagrees with
 * the definition being edited.
 */
export async function readPluginEventAutomationWebhookEndpoint(params: Readonly<{
    webhookEndpointId: string;
    expectedPluginId: string;
    expectedSourceInstanceId: string;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal?: AbortSignal;
    executeAction?: PluginWebhookEndpointUiActionExecutor;
}>): Promise<PluginEventAutomationWebhookEndpointBindingResult> {
    const aborted = (): boolean => params.signal?.aborted === true;
    if (aborted() || !params.accountLifetime.isCurrent()) return { kind: 'unavailable' };
    const input = PluginWebhookEndpointReadInputV1Schema.safeParse({
        webhookEndpointId: params.webhookEndpointId,
    });
    if (!input.success) return { kind: 'unavailable' };

    const execute = params.executeAction ?? executePluginWebhookEndpointAction;
    let result: PluginWebhookEndpointReadResultV1;
    try {
        result = PluginWebhookEndpointReadResultV1Schema.parse(
            await execute('plugin.webhook.endpoint.read', input.data),
        );
    } catch {
        return { kind: 'unavailable' };
    }
    if (
        aborted()
        || !params.accountLifetime.isCurrent()
        || result.routing !== 'accountEndpoint'
        || result.revokedAt !== undefined
        || result.readiness === 'targetUnavailable'
        || result.readiness === 'routeUnavailable'
        || result.contribution.pluginId !== params.expectedPluginId
        || result.targetMaterialization.pluginId !== params.expectedPluginId
        || result.sourceInstanceId !== params.expectedSourceInstanceId
    ) {
        return { kind: 'unavailable' };
    }
    return {
        kind: 'available',
        binding: Object.freeze({
            endpoint: Object.freeze({
                webhookEndpointId: result.webhookEndpointId,
                publicUrl: result.publicUrl,
                readiness: result.readiness,
                // A read never re-discloses the one-time secret.
                oneTimeGeneratedSecret: null,
            }),
            targetMaterialization: result.targetMaterialization,
            sourceInstanceId: result.sourceInstanceId,
        }),
    };
}
