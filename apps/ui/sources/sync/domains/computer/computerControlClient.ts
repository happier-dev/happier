import {
    ComputerActionResultV1Schema,
    ComputerCaptureResponseV1Schema,
    ComputerControlStatusResponseV1Schema,
    ComputerOpenSettingsResponseV1Schema,
    ComputerSelectedTargetResponseV1Schema,
    ComputerTargetsListResponseV1Schema,
    type ActionExecuteResult,
    type ActionExecutorContext,
    type ActionId,
    type ComputerActionResultV1,
    type ComputerAccessV1,
    type ComputerCaptureResponseV1,
    type ComputerControlStatusResponseV1,
    type ComputerSelectedTargetResponseV1,
    type ComputerTargetsListResponseV1,
    type ComputerTargetV1,
    type MachineLiveStreamFrameV1,
} from '@happier-dev/protocol';
import type { z } from 'zod';
import { decodeBase64 } from '@/encryption/base64';

/** The Session and machine whose shared window the person is acting on. */
export type ComputerSessionScope = Readonly<{
    serverId?: string | null;
    sessionId: string;
    machineId: string;
}>;

export type ComputerActionExecute = (actionId: ActionId, input: unknown, context: ActionExecutorContext) => Promise<ActionExecuteResult>;

export type ComputerOutcome<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; code: string }>;

/**
 * The person's computer controls through the one Action front door (Actions settings, the present-user
 * floor and the output schema all apply there). Each call names the Session and the machine; the payload
 * comes back parsed by the Action's own schema or as a stable failure code.
 */
export function createComputerControlClient(scope: ComputerSessionScope, execute: ComputerActionExecute) {
    const context: ActionExecutorContext = {
        surface: 'ui',
        // A person's press in Happier; the daemon route stamps the same authority and checks it again.
        authority: 'present_user',
        defaultSessionId: scope.sessionId,
        ...(scope.serverId ? { serverId: scope.serverId } : {}),
    };
    const machine = { machineId: scope.machineId };
    async function run<T>(actionId: ActionId, input: unknown, schema: z.ZodType<T>): Promise<ComputerOutcome<T>> {
        let result: ActionExecuteResult;
        try {
            result = await execute(actionId, input, context);
        } catch {
            return { ok: false, code: 'machine_unreachable' };
        }
        if (!result.ok) return { ok: false, code: result.errorCode };
        const parsed = schema.safeParse(result.result);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false, code: 'invalid_action_output' };
    }
    return {
        getTarget: () => run<ComputerSelectedTargetResponseV1>('computer.target.get', machine, ComputerSelectedTargetResponseV1Schema),
        listTargets: () => run<ComputerTargetsListResponseV1>('computer.targets.list', machine, ComputerTargetsListResponseV1Schema),
        selectTarget: (target: ComputerTargetV1, access: ComputerAccessV1 = 'use') => run<ComputerSelectedTargetResponseV1>(
            'computer.target.select', { ...machine, target, access }, ComputerSelectedTargetResponseV1Schema),
        openSettings: (permission: 'capture' | 'input') => run(
            'computer.permissions.openSettings', { ...machine, permission }, ComputerOpenSettingsResponseV1Schema),
        status: () => run<ComputerControlStatusResponseV1>('computer.control.status', machine, ComputerControlStatusResponseV1Schema),
        interrupt: () => run<ComputerActionResultV1>('computer.control.interrupt', machine, ComputerActionResultV1Schema),
        handBack: () => run<ComputerActionResultV1>('computer.control.handBack', machine, ComputerActionResultV1Schema),
        /** A fresh look at the window by the person: what confirms an unconfirmed stop. */
        observe: () => run<ComputerCaptureResponseV1>('computer.capture', machine, ComputerCaptureResponseV1Schema),
        stopSharing: () => run<ComputerActionResultV1>('computer.target.close', machine, ComputerActionResultV1Schema),
    };
}

export type ComputerControlClient = ReturnType<typeof createComputerControlClient>;

type ComputerProjectionSnapshot = Readonly<{
    selection: ComputerSelectedTargetResponseV1 | null;
    status: ComputerControlStatusResponseV1 | null;
}>;

const EMPTY_PROJECTION: ComputerProjectionSnapshot = { selection: null, status: null };
const projections = new WeakMap<ComputerActionExecute, Map<string, ComputerSessionProjection>>();
const mountedProjections = new Map<string, Set<ComputerSessionProjection>>();
function projectionKey(scope: ComputerSessionScope): string {
    return JSON.stringify([scope.serverId || null, scope.sessionId, scope.machineId]);
}

/** A refreshable projection of Action answers, never a computer controller. */
function createComputerSessionProjection(scope: ComputerSessionScope, execute: ComputerActionExecute) {
    const client = createComputerControlClient(scope, execute);
    let snapshot = EMPTY_PROJECTION;
    let flight: Promise<void> | null = null;
    let invalidated = false;
    const listeners = new Set<() => void>();
    const key = projectionKey(scope);
    function publish(next: ComputerProjectionSnapshot): void {
        if (JSON.stringify(snapshot) === JSON.stringify(next)) return;
        snapshot = next;
        for (const listener of listeners) listener();
    }
    function applySelection(selection: ComputerSelectedTargetResponseV1, invalidate = true): void {
        if (invalidate && flight) invalidated = true;
        publish({ selection, status: selection.sourceId === snapshot.status?.sourceId ? snapshot.status : null });
    }
    function applyStatus(status: ComputerControlStatusResponseV1): void {
        if (status.sourceId !== snapshot.selection?.sourceId) return;
        publish({ ...snapshot, status });
    }
    function refresh(invalidate = false): Promise<void> {
        if (flight) {
            if (invalidate) invalidated = true;
            return flight;
        }
        flight = (async () => {
            do {
                invalidated = false;
                const selection = await client.getTarget();
                if (invalidated) continue;
                if (selection.ok) applySelection(selection.value, false);
                const previousStatus = snapshot.status;
                const status = await client.status();
                if (invalidated) continue;
                // A stream transition delivered during the read is fresher than that read's answer.
                if (snapshot.status !== previousStatus) continue;
                if (status.ok) applyStatus(status.value);
                else if (!status.ok && status.code === 'computer_target_not_open') publish({ ...snapshot, status: null });
            } while (invalidated);
        })().finally(() => { flight = null; });
        return flight;
    }
    const projection = {
        client,
        getSnapshot: () => snapshot,
        applySelection,
        applyStatus,
        refresh,
        subscribe(listener: () => void) {
            // React can replay the subscription while retaining this projection.
            // Restore its canonical registration after the final-reader cleanup.
            projections.get(execute)?.set(key, projection);
            const first = listeners.size === 0;
            listeners.add(listener);
            let mounted = mountedProjections.get(key);
            if (!mounted) mountedProjections.set(key, mounted = new Set());
            mounted.add(projection);
            if (first) void refresh();
            return () => {
                listeners.delete(listener);
                if (!listeners.size) {
                    mounted?.delete(projection);
                    if (!mounted?.size) mountedProjections.delete(key);
                    // Keep no Session projection after its final reader leaves.
                    const scoped = projections.get(execute);
                    if (scoped?.get(key) === projection) scoped.delete(key);
                }
            };
        },
    };
    return projection;
}

/** The selected source's strict status projection; metadata is never interpreted as image bytes. */
export function publishComputerStatusFrame(scope: ComputerSessionScope, sourceId: string, frame: MachineLiveStreamFrameV1): void {
    if (frame.payloadKind !== 'metadata') return;
    const mounted = mountedProjections.get(projectionKey(scope));
    if (!mounted?.size) return;
    try {
        const parsed = ComputerControlStatusResponseV1Schema.safeParse(JSON.parse(new TextDecoder().decode(decodeBase64(frame.payloadBase64))));
        if (!parsed.success || parsed.data.sourceId !== sourceId) return;
        for (const projection of mounted) projection.applyStatus(parsed.data);
    } catch { /* Malformed metadata never replaces a validated Action/source answer. */ }
}
export type ComputerSessionProjection = ReturnType<typeof createComputerSessionProjection>;

export function getComputerSessionProjection(scope: ComputerSessionScope, execute: ComputerActionExecute): ComputerSessionProjection {
    let scoped = projections.get(execute);
    if (!scoped) projections.set(execute, scoped = new Map());
    const key = projectionKey(scope);
    let projection = scoped.get(key);
    if (!projection) scoped.set(key, projection = createComputerSessionProjection(scope, execute));
    return projection;
}

/** Picker and control Actions invalidate all mounted readers of the same Session/machine. */
export function publishComputerActionAnswer(scope: ComputerSessionScope, actionId: string, answer: unknown): void {
    const mounted = mountedProjections.get(projectionKey(scope));
    if (!mounted?.size) return;
    if (actionId === 'computer.target.select') {
        const selected = ComputerSelectedTargetResponseV1Schema.safeParse(answer);
        if (!selected.success) return;
        for (const projection of mounted) {
            projection.applySelection(selected.data);
            void projection.refresh(true);
        }
    } else if (actionId === 'computer.control.interrupt' || actionId === 'computer.control.handBack'
        || actionId === 'computer.target.close' || actionId === 'computer.capture') {
        const result = actionId === 'computer.capture' ? ComputerCaptureResponseV1Schema.safeParse(answer) : ComputerActionResultV1Schema.safeParse(answer);
        if (!result.success) return;
        for (const projection of mounted) void projection.refresh(true);
    }
}
