import { HealthCheckResultV1ProtocolSchema, SavedHealthCheckSelectorV1ProtocolSchema,
    PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 } from '@happier-dev/plugin-sdk/storage';
import { TELEMETRY_METRICS_READ_ACTION_ID_V1, TELEMETRY_KEY_FLOW_CHECK_ACTION_ID_V1, TELEMETRY_KEY_FLOW_HEALTH_KIND_V1, type TelemetryMetricsReadResultV1 } from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { projectTelemetryMetricsActionReadResultV1 } from '@happier-dev/plugin-sdk/database';
import { databaseActionMetadata } from '@happier-dev/plugin-sdk/actions';
import {
    projectAppCallsUsageV1 as projectDatabaseCaptureUsageV1,
    projectAppCallsCostMetricSeriesV1 as projectDatabaseAppCostMetricSeriesV1,
} from '@happier-dev/plugin-sdk/usage';
import { projectUsagePageCost } from '@happier-dev/plugin-sdk/usage';
import { localCaptureBackground } from './background.js';
import type { CaptureRuntime } from './runtime.js';
import type { CaptureSummary } from './store/capture.js';
import type { TelemetryEnvironmentMetricsReadInputV1 } from '@happier-dev/database-protocol';
import { telemetryPartition } from './telemetry/assignments.js';
import { analyzeKeyFlow, evaluateKeyFlow, keyFlowRouteKey, type KeyFlowMeasurements } from './analysis/keyFlows.js';
import { analyzeMetricWindow, type MetricInterval } from './analysis/metrics.js';
import { keyFlowConfigSchema, keyFlowReadInputSchema, keyFlowReadResultSchema, type KeyFlowReadInput } from './healthSchemas.js';
import { readCaptureCostWindow, loadCaptureCostPricingContext } from './costs.js';

type TrafficReadInput = Omit<KeyFlowReadInput, 'serverId' | 'measure' | 'serviceName'> & { serviceName?: string;
    measure: Exclude<KeyFlowReadInput['measure'], { kind: 'spend' }> };
type TelemetryCapabilities = Awaited<ReturnType<PluginInvocationContext['services']['deploymentTelemetry']['readAssignments']>>[number]['capabilities'];
export type KeyFlowWindow = Awaited<ReturnType<typeof readKeyFlowWindow>> & {
    usage?: NonNullable<TelemetryMetricsReadResultV1['usage']> };

/** Consume the collector's admitted selection; spend does not require the Metrics capability. */
export function keyFlowCapabilityDisabledReason(measure: KeyFlowReadInput['measure'], capabilities: TelemetryCapabilities) {
    return measure.kind === 'spend' ? capabilities?.appLlmCost === true ? undefined : 'app_llm_cost_disabled'
        : capabilities?.metrics === true ? undefined : 'metrics_disabled';
}

function unknown(input: Pick<KeyFlowReadInput, 'measure' | 'since' | 'until'>, reason: string): KeyFlowMeasurements {
    if (input.measure.kind === 'spend') return { measure: 'spend', unit: 'USD', basis: 'catalog_estimate',
        producers: [], window: { since: input.since, until: input.until }, completeness: 'unknown', reasons: [reason] };
    return { measure: input.measure.kind === 'runtime' ? input.measure.metricName : input.measure.statistic,
        unit: input.measure.kind === 'runtime' ? '' : input.measure.statistic === 'errorRate' ? '1'
            : input.measure.statistic === 'requests' ? '{request}' : 'ms', basis: 'metric_points',
        producers: [], window: { since: input.since, until: input.until }, completeness: 'unknown', reasons: [reason] };
}

/** One selected-window read. No stored check results or background analysis are involved. */
export async function readKeyFlowWindow(runtime: CaptureRuntime, input: TrafficReadInput) {
    const worktree = telemetryPartition(input.environmentId);
    const name = input.measure.kind === 'runtime' ? input.measure.metricName : 'http.server.request.duration';
    const points = await runtime.store.metricPoints({ worktree, since: input.since, until: input.until, name,
        serviceName: input.serviceName, serviceVersion: input.serviceVersion });
    const wanted = input.measure.kind === 'route'
        ? new Set(input.measure.routes.map(route => keyFlowRouteKey(route.method, route.route))) : undefined;
    const selectedPoints = wanted ? points.filter(point => wanted.has(keyFlowRouteKey(
        point.dimensions['http.request.method'] ?? point.dimensions['http.method'], point.dimensions['http.route']))) : points;
    const spans: CaptureSummary[] = [];
    if (input.measure.kind !== 'runtime' && (selectedPoints.length === 0
        || input.serviceName === undefined && input.measure.kind === 'http' && input.measure.statistic === 'requests')) {
        let before: Readonly<{ at: number; id: string }> | undefined;
        while (true) {
            const limit = PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1.maximumResultRows;
            const page = await runtime.store.list({ worktree, kind: 'span', spanKind: 2, serviceName: input.serviceName,
                since: input.since, until: input.until, limit, before });
            spans.push(...page);
            // The store may shrink a page at the host byte boundary. Only an
            // empty page is terminal; a short page still has a valid cursor.
            if (page.length === 0) break;
            const last = page.at(-1)!;
            before = { at: last.at, id: last.id };
        }
    }
    const window = { since: input.since, until: input.until };
    const selection = { serviceName: input.serviceName, serviceVersion: input.serviceVersion, measure: input.measure, window };
    const coverage = runtime.ingest.coverage(worktree);
    const withCoverage = (measurement: KeyFlowMeasurements): KeyFlowMeasurements => coverage.lostObservations > 0
        ? { ...measurement, completeness: 'unknown', reasons: ['capture_coverage_lost', ...measurement.reasons] } : measurement;
    const measurements = withCoverage(analyzeKeyFlow({ ...selection, points: selectedPoints, spans }));
    const routes: Array<{ method: string; route: string; measurements: KeyFlowMeasurements }> = [];
    let trend: readonly MetricInterval[];
    if (input.measure.kind !== 'runtime') {
        if (input.measure.kind === 'route') {
            // Partition once; each selected route consumes only its emitted evidence.
            const pointGroups = new Map<string, typeof points[number][]>();
            const spanGroups = new Map<string, CaptureSummary[]>();
            for (const point of selectedPoints) {
                const key = keyFlowRouteKey(point.dimensions['http.request.method'] ?? point.dimensions['http.method'], point.dimensions['http.route']);
                const group = pointGroups.get(key) ?? []; group.push(point); pointGroups.set(key, group);
            }
            for (const span of spans) {
                const key = keyFlowRouteKey(span.endpointMethod, span.endpointRoute);
                const group = spanGroups.get(key) ?? []; group.push(span); spanGroups.set(key, group);
            }
            for (const route of input.measure.routes) {
                const key = keyFlowRouteKey(route.method, route.route);
                routes.push({ ...route, measurements: withCoverage(analyzeKeyFlow({ ...selection, measure: { ...input.measure, routes: [route] },
                    points: pointGroups.get(key) ?? [], spans: spanGroups.get(key) ?? [] })) });
            }
        }
        const selected = selectedPoints;
        if (measurements.basis === 'mixed_telemetry') {
            // Population intervals and individual sampled events do not share comparable count windows.
            trend = [];
        } else if (measurements.basis === 'sampled_spans') {
            const statistic = input.measure.statistic;
            trend = spans.filter(span => (!wanted || wanted.has(keyFlowRouteKey(span.endpointMethod, span.endpointRoute)))
                && typeof span.durationMs === 'number').map(span => ({
                since: span.at, until: span.at + (span.durationMs ?? 0),
                unit: statistic === 'requests' ? '{request}' : statistic === 'errorRate' ? '1' : 'ms', count: 1,
                errorRate: Number(span.outcome === 'error' || (span.httpStatusCode ?? 0) >= 500),
                value: statistic === 'requests' ? 1 : statistic === 'errorRate'
                    ? Number(span.outcome === 'error' || (span.httpStatusCode ?? 0) >= 500) : span.durationMs ?? undefined,
            }));
        } else {
            const result = analyzeMetricWindow(selected, { ...window,
                statistic: input.measure.statistic === 'errorRate' || input.measure.statistic === 'requests' ? 'count'
                    : input.measure.statistic === 'p50' ? 'p50' : 'p95' });
            const scale = result.unit === 's' ? 1000 : result.unit === 'ms' ? 1 : undefined;
            const errors = selected.filter(point => Number(point.dimensions['http.response.status_code'] ?? point.dimensions['http.status_code']) >= 500);
            const failed = analyzeMetricWindow(errors, { ...window, statistic: 'count' });
            const failedIntervals = new Map(failed.intervals.map(interval => [JSON.stringify([interval.since, interval.until]), interval.count]));
            const statusesKnown = selected.every(point => (point.dimensions['http.response.status_code'] ?? point.dimensions['http.status_code']) !== undefined);
            const intervalErrorRate = (interval: MetricInterval) => statusesKnown && interval.count && (!errors.length || failed.status !== 'inconclusive')
                ? (failedIntervals.get(JSON.stringify([interval.since, interval.until])) ?? 0) / interval.count : undefined;
            trend = result.intervals.map(interval => ({ ...interval, unit: scale === undefined ? interval.unit : 'ms',
                ...(interval.value === undefined || scale === undefined ? {} : { value: interval.value * scale }),
                ...(interval.p50 === undefined || scale === undefined ? {} : { p50: interval.p50 * scale }),
                ...(interval.p95 === undefined || scale === undefined ? {} : { p95: interval.p95 * scale }),
                ...(intervalErrorRate(interval) === undefined ? {} : { errorRate: intervalErrorRate(interval) }) }));
            if (input.measure.statistic === 'errorRate' || input.measure.statistic === 'requests') {
                const statistic = input.measure.statistic;
                trend = result.intervals.map(interval => ({ since: interval.since, until: interval.until,
                    unit: statistic === 'requests' ? '{request}' : '1', count: interval.count,
                    ...(intervalErrorRate(interval) === undefined ? {} : { errorRate: intervalErrorRate(interval) }),
                    ...(statistic === 'requests' ? { value: interval.count }
                        : intervalErrorRate(interval) === undefined ? {} : { value: intervalErrorRate(interval) }) }));
            }
        }
    } else {
        const dimensions = input.measure.dimensions ?? [];
        trend = analyzeMetricWindow(points.filter(point => dimensions.every(item => point.dimensions[item.name] === item.value)),
            { ...window, statistic: input.measure.statistic }).intervals;
    }
    return { measurements, routes, trend: [...trend].sort((left, right) => left.since - right.since || left.until - right.until) };
}

/** Both deploy windows share one viewer pricing context; ordinary reads demand just one window. */
export async function readKeyFlowWindows(runtime: CaptureRuntime, inputs: readonly Omit<KeyFlowReadInput, 'serverId'>[],
    context: PluginInvocationContext): Promise<KeyFlowWindow[]> {
    const costReads = await Promise.all(inputs.map(input => input.measure.kind !== 'spend' ? undefined
        : readCaptureCostWindow(runtime, { worktree: telemetryPartition(input.environmentId), serviceName: input.serviceName,
            serviceVersion: input.serviceVersion, since: input.since, until: input.until, granularity: 'hour' })));
    const modelIds = [...new Set(costReads.flatMap(read => read?.items.flatMap(item =>
        [item.modelId, item.requestedModel].filter((id): id is string => id !== null)) ?? []))];
    const pricing = costReads.some(read => read !== undefined) ? await loadCaptureCostPricingContext(context, modelIds) : undefined;
    return Promise.all(inputs.map(async (input, index): Promise<KeyFlowWindow> => {
        if (input.measure.kind !== 'spend') return readKeyFlowWindow(runtime, { ...input, measure: input.measure });
        const read = costReads[index]!;
        const app = projectDatabaseCaptureUsageV1(read, pricing!.catalog, pricing!.viewerOverrides,
            { granularity: 'hour', costMode: input.measure.costMode });
        const selected = projectUsagePageCost(app.accounting, input.measure.costMode);
        // Usage may display a witnessed subtotal beside unpriced facts. A saved
        // spend threshold cannot conclude from that partial monetary population.
        const unpriced = selected.amountUsd === null || app.accounting.costFacts?.some(fact => fact.kind === 'unpriced' && fact.eventCount > 0) === true;
        const reasons = read.coverage.lostObservations > 0 || read.coverage.reason !== null ? ['capture_coverage_lost']
            : read.coverage.callCount === 0 ? ['no_traffic'] : unpriced ? ['unpriced_calls']
                : [...app.accounting.coverage?.reasons ?? []];
        const measurements: KeyFlowMeasurements = { measure: 'spend', unit: 'USD', basis: 'catalog_estimate',
            ...(unpriced ? {} : { value: selected.amountUsd! }),
            producers: [{ serviceName: input.serviceName, ...(input.serviceVersion ? { serviceVersion: input.serviceVersion } : {}) }],
            window: { since: input.since, until: input.until },
            completeness: reasons.includes('capture_coverage_lost') || reasons.includes('no_traffic') || unpriced
                ? 'unknown' : app.accounting.coverage?.status ?? 'unknown', reasons };
        return { measurements, routes: [], trend: [...projectDatabaseAppCostMetricSeriesV1(app)], usage: selected.accounting };
    }));
}

/** Finite health evidence retains the catalog label without storing a tariff or another check result. */
export function evaluateKeyFlowWindow(selected: Pick<KeyFlowWindow, 'measurements' | 'usage'>,
    threshold: Parameters<typeof evaluateKeyFlow>[1], observedAt: number, machineId: string) {
    const result = evaluateKeyFlow(selected.measurements, threshold, observedAt, machineId);
    const catalog = selected.usage?.priceCatalog;
    if (!catalog) return result;
    return { ...result, evidence: { v: 1 as const, items: [...result.evidence!.items,
        { source: { kind: 'alert' as const, label: 'App LLM cost' }, author: { kind: 'process' as const },
            text: `API-equivalent estimate in USD; catalog revision ${catalog.provenance.revision}.` }] } };
}

function metadata(id: typeof TELEMETRY_METRICS_READ_ACTION_ID_V1 | typeof TELEMETRY_KEY_FLOW_CHECK_ACTION_ID_V1) {
    const declaration = databaseActionMetadata[id];
    return { ...declaration, scopes: ['global', 'machine'] as const, surfaces: ['ui', 'cli', 'agent', 'mcp', 'plugin'] as const,
        execution: { target: 'daemon' as const } };
}

/** The saved source owns admission and placement; the collector assignment owns capability selection. */
export const telemetryHealthActions: Record<string, PluginActionDefinition> = {
    [databaseActionLocalIdV1(TELEMETRY_KEY_FLOW_CHECK_ACTION_ID_V1)]: {
        ...metadata(TELEMETRY_KEY_FLOW_CHECK_ACTION_ID_V1), inputSchema: SavedHealthCheckSelectorV1ProtocolSchema,
        resultSchema: HealthCheckResultV1ProtocolSchema,
        async run(value: unknown, context: PluginInvocationContext) {
            const selector = SavedHealthCheckSelectorV1ProtocolSchema.parse(value);
            const source = await context.services.healthChecks.readSource({ sourceInstanceId: selector.sourceInstanceId }, { signal: context.signal });
            const check = source.checks.find(item => item.checkId === selector.checkId);
            if (!check || check.kind.pluginId !== context.plugin.id || check.kind.localId !== TELEMETRY_KEY_FLOW_HEALTH_KIND_V1.localId) {
                throw new PluginError({ code: 'health_check_kind_unavailable' });
            }
            const config = keyFlowConfigSchema.parse(check.config);
            const input = { environmentId: config.environmentId, serviceName: config.serviceName,
                serviceVersion: config.serviceVersion, measure: config.measure,
                since: Math.max(0, context.invokedAtMs - config.windowMs), until: context.invokedAtMs };
            const machineId = context.chosenMachine?.machineId ?? '';
            let reason: string | undefined;
            if (source.subject.kind !== 'environment' || source.subject.environmentId !== config.environmentId) reason = 'health_check_subject_mismatch';
            const assignments = reason ? [] : await context.services.deploymentTelemetry.readAssignments({ signal: context.signal });
            const assignment = assignments.find(item => item.environmentId === config.environmentId);
            if (!reason && !assignment) reason = 'collector_placement_mismatch';
            if (!reason) reason = keyFlowCapabilityDisabledReason(input.measure, assignment?.capabilities);
            const runtime = localCaptureBackground.readRuntime();
            if (!reason && (!machineId || !runtime)) reason = 'collector_unavailable';
            const selected = reason ? { measurements: unknown(input, reason) } : (await readKeyFlowWindows(runtime!, [input], context))[0]!;
            return HealthCheckResultV1ProtocolSchema.parse(projectNativeJsonValueForTransport(
                evaluateKeyFlowWindow(selected, config.threshold, context.invokedAtMs, machineId)));
        },
    },
    [databaseActionLocalIdV1(TELEMETRY_METRICS_READ_ACTION_ID_V1)]: {
        ...metadata(TELEMETRY_METRICS_READ_ACTION_ID_V1), inputSchema: keyFlowReadInputSchema, resultSchema: keyFlowReadResultSchema,
        async run(value: unknown, context: PluginInvocationContext) {
            const input: KeyFlowReadInput | TelemetryEnvironmentMetricsReadInputV1 = keyFlowReadInputSchema.parse(value);
            if (input.until <= input.since) throw new PluginError({ code: 'invalid_parameters' });
            const admit = context.services.deploymentDatabases?.admitTelemetryRead;
            if (!admit) throw new PluginError({ code: 'deployment_target_role_unavailable' });
            if ('environmentIds' in input) {
                const runtime = localCaptureBackground.readRuntime();
                const items = await Promise.all([...new Set(input.environmentIds)].map(async environmentId => {
                    const admitted = await admit({ serverId: input.serverId, environmentId });
                    const selectedInput = { environmentId, since: input.since, until: input.until, measure: input.measure };
                    const reason = keyFlowCapabilityDisabledReason(input.measure, admitted.capabilities) ?? (!runtime ? 'collector_unavailable' : undefined);
                    const selected = reason ? { measurements: unknown(selectedInput, reason), routes: [], trend: [] }
                        : await readKeyFlowWindow(runtime!, selectedInput);
                    return { environmentId, result: evaluateKeyFlowWindow(selected, undefined, context.invokedAtMs, admitted.collectorMachineId),
                        routes: [], trend: selected.trend };
                }));
                return projectTelemetryMetricsActionReadResultV1({ items });
            }
            const admitted = await admit({ serverId: input.serverId, environmentId: input.environmentId });
            const runtime = localCaptureBackground.readRuntime();
            const reason = keyFlowCapabilityDisabledReason(input.measure, admitted.capabilities) ?? (!runtime ? 'collector_unavailable' : undefined);
            const selected: KeyFlowWindow = reason ? { measurements: unknown(input, reason), routes: [], trend: [] }
                : (await readKeyFlowWindows(runtime!, [input], context))[0]!;
            const evaluate = (measurement: KeyFlowMeasurements) => evaluateKeyFlow(measurement, undefined, context.invokedAtMs, admitted.collectorMachineId);
            return projectTelemetryMetricsActionReadResultV1({
                result: evaluateKeyFlowWindow(selected, undefined, context.invokedAtMs, admitted.collectorMachineId),
                routes: selected.routes.map(route => ({ method: route.method, route: route.route,
                    result: evaluate(route.measurements) })), trend: selected.trend,
                ...(selected.usage ? { usage: selected.usage } : {}),
            });
        },
    },
};
