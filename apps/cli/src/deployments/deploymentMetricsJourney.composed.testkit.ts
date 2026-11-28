import { expect, vi } from 'vitest';
import { z } from 'zod';
import { HealthCheckResultV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { TELEMETRY_METRICS_READ_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import type { readS0ControllerCredentials } from './deploymentDaemonIngress.composed.testkit';
import { keyFlowReadResultSchema, type KeyFlowMeasure } from '../../../../packages/plugins/telemetry/src/healthSchemas';
import { healthResultProjectionPageSchema } from '../../../../packages/plugins/machine-services/src/healthResultProjection';

const producerSchema = z.object({ serviceName: z.string(), serviceVersion: z.string().optional(), serviceInstanceId: z.string() });
const flushSchema = z.object({ enabled: z.literal(true), heapUsed: z.number(), producer: producerSchema });
export const productionTelemetryHealthSetupSchema = z.object({ sourceInstanceId: z.string(), sourceContractVersion: z.literal(1), sourceConfig: z.unknown() });

export async function adoptProductionTelemetryHealthCheck(input: Readonly<{
    serverUrl: string; collectorMachineId: string; credentials: ReturnType<typeof readS0ControllerCredentials>;
    signal: AbortSignal; setup: ReturnType<typeof productionTelemetryHealthSetupSchema.parse>;
    accepted(name: string, value: unknown): Promise<unknown>;
}>) {
    const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await callExactMachineRpc({
        credentials: input.credentials, serverUrl: input.serverUrl, machineId: input.collectorMachineId,
        method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
        request: { machineId: input.collectorMachineId, locale: 'en', deferredSections: true, supportedEventObservationBindingVersions: [1] },
        requireCurrentMachine: true, signal: input.signal,
    }));
    const event = projection.automationEligibleEvents?.find(entry => entry.event.identity.pluginId === 'happier.machine.services'
        && entry.event.identity.localId === 'health-check-failed');
    if (!event?.observationBinding) throw new Error('Collector must publish its saved-check observer materialization');
    await input.accepted('workflow.trigger.add', { observationOnly: { kind: 'observationOnly' },
        trigger: { kind: 'pluginEvent', enabled: true, eventRef: event.event.identity,
            sourceInstanceId: input.setup.sourceInstanceId, sourceContractVersion: input.setup.sourceContractVersion, sourceConfig: input.setup.sourceConfig,
            observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: event.observationBinding.materializationRef },
            filter: null, maximumObservationAgeMs: null }, includeEventDefinition: true });
}

/** F15 extends F14's real SDK workload, credentialed Actions, Home and collector B.
 * It deliberately uses the saved-check scheduler and Account result projection. */
export async function runProductionMetricsJourney(input: Readonly<{
    serverId: string; serverUrl: string; environmentId: string; collectorMachineId: string; appUrl: string;
    credentials: ReturnType<typeof readS0ControllerCredentials>; signal: AbortSignal;
    acceptedOnCollector(name: string, value: unknown): Promise<unknown>;
    accepted(name: string, value: unknown): Promise<unknown>;
}>) {
    const request = async (path: string, status = 200) => {
        const response = await fetch(new URL(path, input.appUrl), { signal: input.signal });
        expect(response.status).toBe(status);
        return response;
    };
    const flush = async () => flushSchema.parse(await (await request('/metrics-flush')).json());
    // Establish this emitted histogram stream before its retained baseline.
    await request('/checkout');
    const since = Date.now();
    const baseline = await flush();
    expect(baseline.heapUsed).toBeGreaterThan(0);
    await request('/checkout');
    const emitted = await flush();
    expect(emitted.producer).toEqual(baseline.producer);
    const invoke = (localId: string, value: unknown) => input.acceptedOnCollector('action.invoke', {
        action: { pluginId: 'happier.telemetry', localId }, input: value,
    });
    const read = async (measure: KeyFlowMeasure) => keyFlowReadResultSchema.parse(await invoke(
        databaseActionLocalIdV1(TELEMETRY_METRICS_READ_ACTION_ID_V1), {
            serverId: input.serverId, environmentId: input.environmentId, serviceName: emitted.producer.serviceName,
            ...(emitted.producer.serviceVersion ? { serviceVersion: emitted.producer.serviceVersion } : {}),
            since, until: Date.now(), measure,
        }));
    // The positive admitted read precedes the absent-route case (G1).
    const routeMeasure = { kind: 'route', routes: [{ method: 'GET', route: '/checkout' }], statistic: 'p95' } satisfies KeyFlowMeasure;
    const route = await read(routeMeasure);
    expect(route.result.status).toBe('up');
    expect(route.result.cause?.observerMachineId).toBe(input.collectorMachineId);
    expect(route.result.measurements).toMatchObject({ basis: 'metric_points', unit: 'ms' });
    expect(route.result.measurements?.p95Ms).toBeGreaterThanOrEqual(0);
    expect(route.result.measurements?.p50Ms).toBeGreaterThanOrEqual(0);
    expect(route.result.measurements?.requestCount).toBeGreaterThan(0);
    expect(route.result.measurements?.producers).toEqual(expect.arrayContaining([expect.objectContaining(emitted.producer)]));
    expect(route.trend.length).toBeGreaterThan(0);
    for (const [metricName, statistic, minimum] of [
        ['v8js.memory.heap.used', 'latest', 1], ['v8js.gc.duration', 'mean', 0], ['http.server.active_requests', 'latest', 0],
    ] as const) {
        const result = await read({ kind: 'runtime', metricName, statistic });
        expect(result.result.measurements?.value, metricName).toBeGreaterThanOrEqual(minimum);
        expect(result.result.measurements?.basis).toBe('metric_points');
    }
    expect((await read({ ...routeMeasure, routes: [{ method: 'GET', route: '/not-emitted' }] })).result.status).toBe('unknown');

    const checkId = 'checkout-error-rate';
    const setup = productionTelemetryHealthSetupSchema.parse(await input.acceptedOnCollector('action.invoke', {
        action: { pluginId: 'happier.machine.services', localId: 'health/setup' },
        input: { v: 1, subject: { kind: 'environment', environmentId: input.environmentId },
            checks: [{ checkId, kind: { pluginId: 'happier.telemetry', localId: 'key-flow' }, binding: { kind: 'healthCheck' },
                config: { environmentId: input.environmentId, serviceName: emitted.producer.serviceName,
                    ...(emitted.producer.serviceVersion ? { serviceVersion: emitted.producer.serviceVersion } : {}),
                    measure: { ...routeMeasure, statistic: 'errorRate' }, windowMs: 5000,
                    threshold: { operator: 'above', value: 0.1 } },
                periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }], investigation: { mode: 'inbox' } },
    }));
    await adoptProductionTelemetryHealthCheck({ ...input, setup });
    const retained = async () => {
        const page = healthResultProjectionPageSchema.parse(await input.accepted('action.invoke', {
            action: { pluginId: 'happier.machine.services', localId: 'health/results' }, input: {},
        }));
        return page.items.find(item => item.source?.sourceInstanceId === setup.sourceInstanceId)?.projection.checks
            .find(check => check.checkId === checkId);
    };
    await vi.waitFor(async () => {
        await request('/checkout?fail=1', 500); await flush();
        expect((await retained())?.result.status).toBe('down');
    }, { timeout: 30_000, interval: 1000 });
    await vi.waitFor(async () => {
        await request('/checkout'); await flush();
        const check = await retained();
        expect(check?.result.status).toBe('up');
        expect(check?.recentResults?.some(result => result.status === 'down')).toBe(true);
        expect(check?.recentResults?.some(result => result.status === 'up')).toBe(true);
        expect(check?.history?.days.some(day => day.down > 0 && day.up > 0)).toBe(true);
        HealthCheckResultV1ProtocolSchema.parse(check?.result);
    }, { timeout: 30_000, interval: 1000 });
    console.info('F15 real SDK metrics and persisted Key flow recovered', { environmentId: input.environmentId,
        collectorMachineId: input.collectorMachineId, producer: emitted.producer, trendIntervals: route.trend.length });
}
