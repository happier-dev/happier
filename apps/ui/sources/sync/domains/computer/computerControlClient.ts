import { ComputerActionResultV1Schema, ComputerCaptureResponseV1Schema, ComputerControlStatusResponseV1Schema, ComputerOpenSettingsResponseV1Schema, ComputerSelectedTargetResponseV1Schema, ComputerTargetsListResponseV1Schema, type ComputerActionResultV1, type ComputerAccessV1, type ComputerCaptureResponseV1, type ComputerControlStatusResponseV1, type ComputerSelectedTargetResponseV1, type ComputerTargetsListResponseV1, type ComputerTargetV1 } from '@happier-dev/protocol/computer/v1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { MachineLiveStreamFrameV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import type { z } from 'zod';
import { decodeBase64 } from '@/encryption/base64';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import type { UiActionExecutorContext } from '@/sync/ops/actions/defaultActionExecutor';

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
export function createComputerControlClient(scope: ComputerSessionScope, execute: ComputerActionExecute, accountLifetime?: ServerAccountScopeLifetime | null) {
    const serverId = scope.serverId ?? accountLifetime?.scope.serverId;
    const isCurrent = () => accountLifetime === undefined || (accountLifetime !== null && accountLifetime.isCurrent()
        && selectActiveServerAccountScopeForServer(accountLifetime.scope, serverId ?? accountLifetime.scope.serverId) !== null);
    const context: UiActionExecutorContext = {
        surface: 'ui',
        // A person's press in Happier; the daemon route stamps the same authority and checks it again.
        authority: 'present_user',
        defaultSessionId: scope.sessionId,
        ...(serverId ? { serverId } : {}),
        ...(accountLifetime ? { expectedAccountId: accountLifetime.scope.accountId } : {}),
    };
    const machine = { machineId: scope.machineId };
    async function run<T>(actionId: ActionId, input: unknown, schema: z.ZodType<T>): Promise<ComputerOutcome<T>> {
        if (!isCurrent()) return { ok: false, code: 'action_account_scope_changed' };
        let result: ActionExecuteResult;
        try {
            result = await execute(actionId, input, context);
        } catch {
            return { ok: false, code: 'machine_unreachable' };
        }
        const effectClass = getActionSpec(actionId).sideEffectClass;
        // Reads may not disclose a retired Account's answer. An already-issued
        // effect keeps its acknowledgement rather than suggesting a safe retry.
        if (!isCurrent() && (effectClass === 'none' || effectClass === 'read')) {
            return { ok: false, code: 'action_account_scope_changed' };
        }
        if (!result.ok) return { ok: false, code: result.errorCode };
        const parsed = schema.safeParse(result.result);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false, code: 'invalid_action_output' };
    }
    return {
        isCurrent,
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
    grants: ComputerTargetsListResponseV1['grants'] | null;
    failure: string | null;
}>;

const EMPTY_PROJECTION: ComputerProjectionSnapshot = { selection: null, status: null, grants: null, failure: null };
const projections = new WeakMap<ComputerActionExecute, Map<string, ComputerSessionProjection>>();
const mountedProjections = new Map<string, Set<ComputerSessionProjection>>();
function projectionKey(scope: ComputerSessionScope): string {
    return JSON.stringify([scope.serverId || null, scope.sessionId, scope.machineId]);
}

/** A refreshable projection of Action answers, never a computer controller. */
function createComputerSessionProjection(scope: ComputerSessionScope, execute: ComputerActionExecute, accountLifetime?: ServerAccountScopeLifetime | null) {
    const client = createComputerControlClient(scope, execute, accountLifetime);
    let snapshot = EMPTY_PROJECTION;
    let flight: Promise<void> | null = null;
    let invalidated = false;
    const listeners = new Map<() => void, boolean>();
    const key = projectionKey(scope);
    const hasDemand = () => client.isCurrent() && [...listeners.values()].some(Boolean);
    let retirement: Readonly<{ dispose(): void }> | null = null;
    function publish(next: ComputerProjectionSnapshot): void {
        if (JSON.stringify(snapshot) === JSON.stringify(next)) return;
        snapshot = next;
        for (const listener of listeners.keys()) listener();
    }
    function applySelection(selection: ComputerSelectedTargetResponseV1, invalidate = true): void {
        if (!client.isCurrent()) return;
        if (invalidate && flight) invalidated = true;
        const admitted = snapshot.grants && snapshot.grants.capture !== 'granted' ? null : selection;
        publish({ ...snapshot, selection: admitted, status: admitted?.sourceId === snapshot.status?.sourceId ? snapshot.status : null,
            failure: admitted === null ? snapshot.failure : null });
    }
    function applyFailure(code: string): void {
        if (!client.isCurrent()) return;
        publish({ ...snapshot, selection: null, status: null, failure: code });
    }
    function applyReadiness(targets: ComputerTargetsListResponseV1): void {
        if (!client.isCurrent()) return;
        const readable = targets.grants.capture === 'granted';
        publish({ ...snapshot, grants: targets.grants,
            ...(!readable ? { selection: null, status: null, failure: targets.grants.capture === 'denied' ? 'capture_permission_denied' : 'capture_permission_unknown' }
                : { failure: null }) });
    }
    function applyStatus(status: ComputerControlStatusResponseV1): void {
        if (!client.isCurrent()) return;
        if (status.sourceId !== snapshot.selection?.sourceId) return;
        publish({ ...snapshot, status });
    }
    function refresh(invalidate = false): Promise<void> {
        if (!hasDemand()) return Promise.resolve();
        if (flight) {
            if (invalidate) invalidated = true;
            return flight;
        }
        flight = (async () => {
            do {
                if (!hasDemand()) break;
                invalidated = false;
                const selection = await client.getTarget();
                if (!hasDemand()) break;
                if (invalidated) continue;
                if (!selection.ok) { applyFailure(selection.code); continue; }
                // OS grants can change while a viewer is parked or Settings is open.
                // Re-observe them at this existing refresh boundary before restoring a source.
                if (selection.value.sourceId) {
                    const targets = await client.listTargets();
                    if (!hasDemand()) break;
                    if (invalidated) continue;
                    if (!targets.ok) { applyFailure(targets.code); continue; }
                    applyReadiness(targets.value);
                }
                applySelection(selection.value, false);
                if (!snapshot.selection?.sourceId || !hasDemand()) continue;
                const previousStatus = snapshot.status;
                const status = await client.status();
                if (!hasDemand()) break;
                if (invalidated) continue;
                // A stream transition delivered during the read is fresher than that read's answer.
                if (snapshot.status !== previousStatus) continue;
                if (status.ok) applyStatus(status.value);
                else applyFailure(status.code);
            } while (invalidated);
        })().finally(() => { flight = null; });
        return flight;
    }
    const projection = {
        client,
        accountLifetime,
        getSnapshot: () => client.isCurrent() ? snapshot : EMPTY_PROJECTION,
        applySelection,
        applyStatus,
        applyReadiness,
        applyFailure,
        refresh,
        subscribe(listener: () => void, active = true) {
            // React can replay the subscription while retaining this projection.
            // Restore its canonical registration after the final-reader cleanup.
            if (client.isCurrent()) projections.get(execute)?.set(key, projection);
            const hadDemand = hasDemand();
            listeners.set(listener, active);
            retirement ??= accountLifetime?.onRetire(() => {
                mountedProjections.get(key)?.delete(projection);
                if (!mountedProjections.get(key)?.size) mountedProjections.delete(key);
                const scoped = projections.get(execute);
                if (scoped?.get(key) === projection) scoped.delete(key);
                publish(EMPTY_PROJECTION);
            }) ?? null;
            if (active && client.isCurrent()) {
                let mounted = mountedProjections.get(key);
                if (!mounted) mountedProjections.set(key, mounted = new Set());
                mounted.add(projection);
                if (!hadDemand) void refresh();
            }
            return () => {
                listeners.delete(listener);
                if (!hasDemand()) {
                    const mounted = mountedProjections.get(key);
                    mounted?.delete(projection);
                    if (!mounted?.size) mountedProjections.delete(key);
                }
                if (!listeners.size) {
                    retirement?.dispose();
                    retirement = null;
                    // A parked reader retains source identity without demanding status or frames.
                    // Retire only when its final mounted reader actually leaves.
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

export function getComputerSessionProjection(scope: ComputerSessionScope, execute: ComputerActionExecute, accountLifetime?: ServerAccountScopeLifetime | null): ComputerSessionProjection {
    // An unavailable or mismatched binding must not displace a current Account's shared reader.
    if (!createComputerControlClient(scope, execute, accountLifetime).isCurrent()) {
        return createComputerSessionProjection(scope, execute, accountLifetime);
    }
    let scoped = projections.get(execute);
    if (!scoped) projections.set(execute, scoped = new Map());
    const key = projectionKey(scope);
    let projection = scoped.get(key);
    if (!projection || projection.accountLifetime !== accountLifetime) {
        scoped.set(key, projection = createComputerSessionProjection(scope, execute, accountLifetime));
    }
    return projection;
}

/** Picker and control Actions invalidate all mounted readers of the same Session/machine. */
export function publishComputerActionAnswer(scope: ComputerSessionScope, actionId: string, answer: unknown): void {
    const mounted = mountedProjections.get(projectionKey(scope));
    if (!mounted?.size) return;
    if (actionId === 'computer.targets.list') {
        const targets = ComputerTargetsListResponseV1Schema.safeParse(answer);
        if (targets.success) for (const projection of mounted) projection.applyReadiness(targets.data);
    } else if (actionId === 'computer.target.select') {
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
