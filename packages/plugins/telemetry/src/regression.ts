import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginActionDefinition, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import { withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { TELEMETRY_REGRESSIONS_COMPARE_ACTION_ID_V1, TELEMETRY_REGRESSIONS_SCHEDULE_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import { compareDatabaseEvidenceWindowsV1 } from '@happier-dev/databases/stats-comparisons';
import { databaseActionLocalIdV1, databaseActionMetadata } from '@happier-dev/plugin-sdk/actions';
import { localCaptureBackground } from './background.js';
import { evaluateKeyFlowWindow, keyFlowCapabilityDisabledReason, readKeyFlowWindows } from './health.js';
import { regressionCompareInputSchema, regressionCompareResultSchema, regressionScheduleInputSchema,
    regressionScheduleResultSchema } from './regressionSchemas.js';

type Receipt = Extract<PluginActionResultById['deployments.receipts.list'], { ok: true }>['items'][number];

function metadata(id: typeof TELEMETRY_REGRESSIONS_COMPARE_ACTION_ID_V1 | typeof TELEMETRY_REGRESSIONS_SCHEDULE_ACTION_ID_V1) {
    const declaration = databaseActionMetadata[id];
    return { ...declaration, scopes: ['global', 'machine'] as const, surfaces: ['ui', 'cli', 'agent', 'mcp', 'plugin'] as const,
        execution: { target: 'daemon' as const } };
}

/** History is read at firing. Receipt ids are display evidence, never metric cohort identities. */
async function successfulDeployments(context: PluginInvocationContext, input: { serverId: string; environmentId: string }) {
    const receipts: Receipt[] = [];
    let cursor: string | undefined;
    do {
        const result = await context.services.actions.execute('deployments.receipts.list', { ...input, state: 'succeeded',
            ...(cursor ? { cursor } : {}) }, { signal: context.signal });
        if (!('ok' in result) || !result.ok) throw withActionFailureDiagnostic(new PluginError({
            code: 'ok' in result ? result.error : 'approval_required',
        }), { phase: 'telemetry.regressions.history', causeKind: 'native_failure', error: result });
        receipts.push(...result.items.filter(item => item.operation !== 'teardown' && item.settledAtMs !== undefined));
        cursor = result.nextCursor ?? undefined;
    } while (cursor);
    return receipts.sort((a, b) => b.settledAtMs! - a.settledAtMs!);
}

export const telemetryRegressionActions = {
    [databaseActionLocalIdV1(TELEMETRY_REGRESSIONS_COMPARE_ACTION_ID_V1)]: {
        ...metadata(TELEMETRY_REGRESSIONS_COMPARE_ACTION_ID_V1), inputSchema: regressionCompareInputSchema,
        resultSchema: regressionCompareResultSchema,
        async run(value: unknown, context: PluginInvocationContext) {
            const input = regressionCompareInputSchema.parse(value);
            const admit = context.services.deploymentDatabases?.admitTelemetryRead;
            if (!admit) throw new PluginError({ code: 'deployment_target_role_unavailable' });
            const admitted = await admit({ serverId: input.serverId, environmentId: input.environmentId });
            const inconclusive = (reason: string) => ({ status: 'inconclusive' as const, reasons: [reason] });
            const disabled = keyFlowCapabilityDisabledReason(input.measure, admitted.capabilities);
            if (disabled) return inconclusive(disabled);
            const runtime = localCaptureBackground.readRuntime();
            if (!runtime) return inconclusive('collector_unavailable');
            const history = await successfulDeployments(context, { serverId: input.serverId, environmentId: input.environmentId });
            const live = history[0];
            const previous = history.find(item => item.id !== live?.id && item.settledAtMs! < live!.settledAtMs!);
            if (!live || !previous) return inconclusive('previous_deployment_required');
            const boundary = live.settledAtMs!;
            const duration = Math.min(input.windowMs, context.invokedAtMs - boundary);
            const basis = { liveDeploymentId: live.id, previousDeploymentId: previous.id };
            if (duration <= 0) return { ...basis, ...inconclusive('observation_window_empty') };
            if (boundary - duration < previous.settledAtMs!) return { ...basis, ...inconclusive('previous_window_incomplete') };
            const selected = { environmentId: input.environmentId, serviceName: input.serviceName, measure: input.measure };
            const [before, after] = await readKeyFlowWindows(runtime, [
                { ...selected, since: boundary - duration, until: boundary },
                { ...selected, since: context.invokedAtMs - duration, until: context.invokedAtMs },
            ], context);
            const comparison = compareDatabaseEvidenceWindowsV1(before.measurements, after.measurements);
            const evidence = { ...basis,
                before: evaluateKeyFlowWindow(before, undefined, context.invokedAtMs, admitted.collectorMachineId),
                after: evaluateKeyFlowWindow(after, undefined, context.invokedAtMs, admitted.collectorMachineId) };
            return regressionCompareResultSchema.parse(projectNativeJsonValueForTransport(comparison.status === 'comparable'
                ? { ...evidence, status: comparison.status, change: comparison.change, changePercent: comparison.changePercent }
                : { ...evidence, ...comparison }));
        },
    },
    [databaseActionLocalIdV1(TELEMETRY_REGRESSIONS_SCHEDULE_ACTION_ID_V1)]: {
        ...metadata(TELEMETRY_REGRESSIONS_SCHEDULE_ACTION_ID_V1), inputSchema: regressionScheduleInputSchema,
        resultSchema: regressionScheduleResultSchema,
        async run(value: unknown, context: PluginInvocationContext): Promise<ReturnType<typeof regressionScheduleResultSchema.parse>> {
            const input = regressionScheduleInputSchema.parse(value);
            const receipt = await context.services.actions.execute('deployments.receipts.get', {
                serverId: input.serverId, deploymentId: input.deploymentId,
            }, { signal: context.signal });
            if (!('ok' in receipt) || !receipt.ok) throw withActionFailureDiagnostic(new PluginError({
                code: 'ok' in receipt ? receipt.error : 'approval_required',
            }), { phase: 'telemetry.regressions.receipt', causeKind: 'native_failure', error: receipt });
            const deployment = receipt.deployment;
            if (deployment.environmentId !== input.environmentId || deployment.state !== 'succeeded' || deployment.settledAtMs === undefined) {
                throw new PluginError({ code: 'deployment_unavailable', message: 'A successful finished deployment is required.' });
            }
            return { kind: 'schedule', enabled: true,
                schedule: { kind: 'once', scheduledAt: deployment.settledAtMs + input.observationDelayMs } };
        },
    },
} satisfies Record<string, PluginActionDefinition>;
