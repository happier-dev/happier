import {
    AutomationRunExecutionTargetV1Schema,
    ExecutionRunDetachedStartRequestV1Schema,
    SessionServerStartSpawnDraftV1Schema,
    type AutomationRunExecutionTargetV1,
} from '@happier-dev/protocol';

export type PluginEventAutomationTargetKind = AutomationRunExecutionTargetV1['kind'];

export type PluginEventAutomationResolvedTarget = Readonly<{
    target: AutomationRunExecutionTargetV1;
    assignmentMachineId: string;
}>;

function normalizeIdentifier(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * The editor-level projection of a selected Event target. It has no mutation
 * authority: it only validates the strict durable target and exposes the one
 * machine assignment dictated by that target.
 */
export function resolvePluginEventAutomationTarget(params: Readonly<{
    kind: PluginEventAutomationTargetKind;
    newSessionSpawn?: unknown;
    existingSession?: Readonly<{
        sessionId: string;
        availability: Readonly<{ kind: string; machineId?: string }>;
    }> | null;
    executionRun?: Readonly<{
        machineId: string;
        request: unknown;
    }> | null;
}>): PluginEventAutomationResolvedTarget | null {
    switch (params.kind) {
        case 'newSession': {
            const spawn = SessionServerStartSpawnDraftV1Schema.safeParse(params.newSessionSpawn);
            if (!spawn.success) return null;
            const target = AutomationRunExecutionTargetV1Schema.safeParse({
                kind: 'newSession',
                spawn: spawn.data,
            });
            return target.success
                ? Object.freeze({
                    target: target.data,
                    assignmentMachineId: spawn.data.executionTarget.machineId,
                })
                : null;
        }
        case 'existingSession': {
            const sessionId = normalizeIdentifier(params.existingSession?.sessionId);
            const machineId = params.existingSession?.availability.kind === 'ready'
                ? normalizeIdentifier(params.existingSession.availability.machineId)
                : null;
            if (!sessionId || !machineId) return null;
            const target = AutomationRunExecutionTargetV1Schema.safeParse({
                kind: 'existingSession',
                sessionId,
            });
            return target.success
                ? Object.freeze({ target: target.data, assignmentMachineId: machineId })
                : null;
        }
        case 'executionRun': {
            const machineId = normalizeIdentifier(params.executionRun?.machineId);
            const request = ExecutionRunDetachedStartRequestV1Schema.safeParse(params.executionRun?.request);
            if (!machineId || !request.success) return null;
            const target = AutomationRunExecutionTargetV1Schema.safeParse({
                kind: 'executionRun',
                request: request.data,
            });
            return target.success
                ? Object.freeze({ target: target.data, assignmentMachineId: machineId })
                : null;
        }
    }
}
