import { computeCanonicalDomainSeparatedDigest, createCanonicalJsonSigningInput, HealthCheckResultV1ProtocolSchema,
    SavedHealthCheckSelectorV1ProtocolSchema, type HealthCheckResultV1, type HealthCheckSourceConfigV1,
    type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { defineProtocolNumber, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { requireAccountStorage } from '@happier-dev/plugin-sdk/storage';
import { decodePluginWebhookActionRawBody, PluginWebhookActionInputSchema, PluginWebhookActionResultSchema } from '@happier-dev/plugin-sdk/webhooks';
import { monitorDefinitions, monitorKinds, type MonitorKind } from './monitorDefinitions.js';
import { MACHINE_SERVICES_PLUGIN_ID } from './healthSetup.js';
import { normalizeGatusInput, normalizeUptimeKumaInput } from './monitorInputs.js';

const retainedSchema = defineProtocolObject({ basis: defineProtocolString(), deliveryId: defineProtocolString(),
    receivedAt: defineProtocolNumber({ integer: true, minimum: 0 }), result: HealthCheckResultV1ProtocolSchema }, { policy: 'closed' });
const keyFor = (source: string, check: string) => `health-monitor:${computeCanonicalDomainSeparatedDigest('happier.health.monitor.v1', [source, check])}`;
const basisFor = (source: HealthCheckSourceConfigV1) => createCanonicalJsonSigningInput(source);
const mapping = (kind: MonitorKind, check: HealthCheckSourceConfigV1['checks'][number]) =>
    check.kind.pluginId === MACHINE_SERVICES_PLUGIN_ID && check.kind.localId === kind
        ? monitorDefinitions[kind].configSchema.parse(check.config) : null;
const unknown = (observedAt: number): HealthCheckResultV1 => ({ status: 'unknown', observedAt,
    evidence: { v: 1, items: [{ source: { kind: 'alert', label: 'External monitor' }, author: { kind: 'process' },
        text: 'No observation for this saved mapping.' }] } });
const settled = (disposition: 'accepted' | 'ignored') => ({ kind: 'settled' as const, disposition });

const readAction = (kind: MonitorKind) => ({
    title: `Read saved ${monitorDefinitions[kind].title}`, execution: { target: 'daemon' as const },
    scopes: ['global', 'machine'] as const, surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'] as const,
    dangerLevel: 'safe' as const, readOnly: true,
    inputSchema: SavedHealthCheckSelectorV1ProtocolSchema, resultSchema: HealthCheckResultV1ProtocolSchema,
    async run(value: unknown, context: PluginInvocationContext): Promise<HealthCheckResultV1> {
        const selector = SavedHealthCheckSelectorV1ProtocolSchema.parse(value);
        const source = await context.services.healthChecks.readSource({ sourceInstanceId: selector.sourceInstanceId }, { signal: context.signal });
        const check = source.checks.find(item => item.checkId === selector.checkId);
        if (!check || !mapping(kind, check)) return unknown(context.invokedAtMs);
        const entry = await requireAccountStorage(context, { code: 'health_check_storage_unavailable', message: 'Health status storage is unavailable' }).kv.get(keyFor(selector.sourceInstanceId, selector.checkId), { signal: context.signal });
        const retained = entry && !('deleted' in entry) ? retainedSchema.parse(entry.value) : null;
        return retained?.basis === basisFor(source) ? retained.result : unknown(context.invokedAtMs);
    },
});
const receiveAction = (kind: MonitorKind) => ({
    title: `Receive ${monitorDefinitions[kind].title}`, execution: { target: 'daemon' as const },
    scopes: ['global', 'machine'] as const, surfaces: ['plugin'] as const, dangerLevel: 'safe' as const, readOnly: false,
    inputSchema: PluginWebhookActionInputSchema.jsonSchema, resultSchema: PluginWebhookActionResultSchema.jsonSchema,
    async run(value: unknown, context: PluginInvocationContext) {
        const input = PluginWebhookActionInputSchema.parse(value);
        const definition = monitorDefinitions[kind];
        if (input.verified.verifier !== 'capabilityUrl_v1' || input.endpoint.webhookContribution.pluginId !== MACHINE_SERVICES_PLUGIN_ID
            || input.endpoint.webhookContribution.localId !== definition.webhookContributionId || !input.endpoint.webhookEndpointId) return settled('ignored');
        let body: unknown;
        try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodePluginWebhookActionRawBody(input))); }
        catch { return settled('ignored'); }
        const normalized = (kind === 'uptime-kuma' ? normalizeUptimeKumaInput : normalizeGatusInput)(body, input.delivery.receivedAtMs);
        if (!normalized) return settled('ignored');
        const source = await context.services.healthChecks.readSource({ sourceInstanceId: input.endpoint.sourceInstanceId }, { signal: context.signal });
        const selected = source.checks.flatMap(check => {
            const config = mapping(kind, check);
            if (!config || config.webhookEndpointId !== input.endpoint.webhookEndpointId
                || typeof config.observingSince !== 'number' || input.delivery.receivedAtMs < config.observingSince) return [];
            const monitorId = 'monitorId' in config ? config.monitorId : JSON.stringify([config.endpointGroup, config.endpointName]);
            return monitorId === normalized.monitorId ? [check] : [];
        });
        if (!selected.length) return settled('ignored');
        const kv = requireAccountStorage(context, { code: 'health_check_storage_unavailable', message: 'Health status storage is unavailable' }).kv;
        const basis = basisFor(source);
        for (const check of selected) {
            const accepted = await kv.transaction(async store => {
                const key = keyFor(input.endpoint.sourceInstanceId, check.checkId);
                const entry = await store.get(key, { signal: context.signal });
                const previous = entry && !('deleted' in entry) ? retainedSchema.parse(entry.value) : null;
                if (previous?.basis === basis) {
                    // Re-emit the wake after an interrupted emit; the observer owns result dedupe.
                    if (previous.deliveryId === input.delivery.deliveryId) return true;
                    if (previous.receivedAt > input.delivery.receivedAtMs
                        || previous.result.observedAt > normalized.result.observedAt
                        || previous.result.observedAt === normalized.result.observedAt && previous.result.status === normalized.result.status) return false;
                }
                await store.set(key, { basis, deliveryId: input.delivery.deliveryId,
                    receivedAt: input.delivery.receivedAtMs, result: normalized.result },
                    { expectedVersion: entry?.version ?? 'absent', signal: context.signal });
                return true;
            }, { signal: context.signal });
            if (accepted) await context.services.events.plugin.emit(definition.observedEventId, {
                sourceInstanceId: input.endpoint.sourceInstanceId, checkId: check.checkId,
                webhookEndpointId: input.endpoint.webhookEndpointId,
            }, { signal: context.signal });
        }
        return settled('accepted');
    },
});
export const monitorActions = Object.fromEntries(monitorKinds.flatMap(kind => [
    [`health/${kind}`, readAction(kind)], [`health/${kind}/receive`, receiveAction(kind)],
]));
