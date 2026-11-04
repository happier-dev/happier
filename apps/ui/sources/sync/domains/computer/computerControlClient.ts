import { ComputerActionResultV1Schema, ComputerCaptureResponseV1Schema, ComputerControlStatusResponseV1Schema, ComputerOpenSettingsResponseV1Schema, ComputerSelectedTargetResponseV1Schema, ComputerTargetsListResponseV1Schema, type ComputerActionResultV1, type ComputerAccessV1, type ComputerCaptureResponseV1, type ComputerControlStatusResponseV1, type ComputerSelectedTargetResponseV1, type ComputerTargetsListResponseV1, type ComputerTargetV1 } from '@happier-dev/protocol/computer/v1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { computerSourceIdentityKeyV1, resolveComputerAccess, type ComputerSourceIdentityV1 } from '@happier-dev/protocol/computer/v1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { MachineLiveStreamFrameV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import type { z } from 'zod/mini';
import { decodeBase64 } from '@/encryption/base64';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import type { UiActionExecutorContext } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveComputerRecovery } from './targets';
import { ComputerClipboardResultV1Schema, type ComputerClipboardOperationV1, type ComputerClipboardResultV1 } from '@happier-dev/protocol/computer/v1';

/** The Session and machine whose shared window the person is acting on. */
export type ComputerSessionScope = Readonly<{
    serverId?: string | null;
    sessionId: string;
    machineId: string;
}>;

/** A person can share this Machine's desktop independently of an agent Session. */
export type ComputerMachinePersonScope = Readonly<{
    serverId?: string | null;
    machineId: string;
    source: Extract<ComputerSourceIdentityV1, { kind: 'machine-person' }>;
    sessionId?: never;
}>;
export type ComputerScope = ComputerSessionScope | ComputerMachinePersonScope;

/** One identity owner for Action projections, stream metadata and picker state. */
function sourceIdentity(scope: ComputerScope): ComputerSourceIdentityV1 {
    return 'source' in scope ? scope.source : { kind: 'session' as const, sessionId: scope.sessionId };
}

export type ComputerActionExecute = (actionId: ActionId, input: unknown, context: ActionExecutorContext) => Promise<ActionExecuteResult>;

export type ComputerOutcome<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; code: string }>;

/**
 * The person's computer controls through the one Action front door (Actions settings and the
 * output schema apply there). Each call names the machine and its source; the payload
 * comes back parsed by the Action's own schema or as a stable failure code.
 */
export function createComputerControlClient(scope: ComputerScope, execute: ComputerActionExecute, accountLifetime?: ServerAccountScopeLifetime | null) {
    const serverId = scope.serverId ?? accountLifetime?.scope.serverId;
    const isCurrent = () => accountLifetime === undefined || (accountLifetime !== null && accountLifetime.isCurrent()
        && (!('source' in scope) || scope.source.personId === accountLifetime.scope.accountId)
        && selectActiveServerAccountScopeForServer(accountLifetime.scope, serverId ?? accountLifetime.scope.serverId) !== null);
    const context: UiActionExecutorContext = {
        surface: 'ui',
        // A person's press in Happier; authority identifies whose native input this is.
        authority: 'present_user',
        ...(scope.sessionId ? { defaultSessionId: scope.sessionId } : {}),
        ...('source' in scope ? { runtimeAccountId: scope.source.personId } : {}),
        ...(serverId ? { serverId } : {}),
        ...(accountLifetime ? { expectedAccountId: accountLifetime.scope.accountId } : {}),
    };
    const machine = { machineId: scope.machineId };
    async function run<T>(actionId: ActionId, input: unknown, schema: z.ZodMiniType<T>): Promise<ComputerOutcome<T>> {
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
        clipboard: (operation: ComputerClipboardOperationV1) => run<ComputerClipboardResultV1>(
            operation.kind === 'read' ? 'computer.clipboard.read' : 'computer.clipboard.write',
            { ...machine, ...(operation.kind === 'write' ? { text: operation.text } : {}) }, ComputerClipboardResultV1Schema),
        getTarget: () => run<ComputerSelectedTargetResponseV1>('computer.target.get', machine, ComputerSelectedTargetResponseV1Schema),
        listTargets: () => run<ComputerTargetsListResponseV1>('computer.targets.list', machine, ComputerTargetsListResponseV1Schema),
        selectTarget: (target: ComputerTargetV1, access?: ComputerAccessV1) => run<ComputerSelectedTargetResponseV1>(
            'computer.target.select', { ...machine, target, access: resolveComputerAccess(access) }, ComputerSelectedTargetResponseV1Schema),
        openSettings: (permission: 'capture' | 'input') => run(
            'computer.permissions.openSettings', { ...machine, permission }, ComputerOpenSettingsResponseV1Schema),
        status: () => run<ComputerControlStatusResponseV1>('computer.control.status', machine, ComputerControlStatusResponseV1Schema),
        interrupt: () => run<ComputerActionResultV1>('computer.control.interrupt', machine, ComputerActionResultV1Schema),
        handBack: () => run<ComputerActionResultV1>('computer.control.handBack', machine, ComputerActionResultV1Schema),
        /** A fresh look at the window by the person: what confirms an unconfirmed stop. */
        observe: (identity?: Readonly<{ target: ComputerTargetV1; sourceId: string }>) => run<ComputerCaptureResponseV1>(
            'computer.capture', { ...machine, ...identity }, ComputerCaptureResponseV1Schema),
        stopSharing: async (): Promise<ComputerOutcome<ComputerActionResultV1>> => {
            const result = await run<ComputerActionResultV1>('computer.target.close', machine, ComputerActionResultV1Schema);
            if (!result.ok || result.value.status !== 'dispatched') return result;
            // A dispatched close is not permission to hide a still-selected source.
            // Both the viewer and picker consume this same canonical confirmation.
            const confirmed = await run<ComputerSelectedTargetResponseV1>('computer.target.get', machine, ComputerSelectedTargetResponseV1Schema);
            if (!confirmed.ok) return confirmed;
            if (confirmed.value.sourceId || confirmed.value.selectedTarget || confirmed.value.consentGranted
                || !confirmed.value.approvalDisplay.requiresTargetSelection) {
                return { ok: false, code: 'control_not_drained' };
            }
            for (const projection of mountedProjections.get(computerScopeKey(scope)) ?? []) {
                projection.applySelection(confirmed.value);
            }
            return result;
        },
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
export function computerScopeKey(scope: ComputerScope): string {
    return JSON.stringify([scope.serverId || null, scope.machineId, computerSourceIdentityKeyV1(sourceIdentity(scope))]);
}


/** A refreshable projection of Action answers, never a computer controller. */
function createComputerSessionProjection(scope: ComputerScope, execute: ComputerActionExecute, accountLifetime?: ServerAccountScopeLifetime | null) {
    const client = createComputerControlClient(scope, execute, accountLifetime);
    let snapshot = EMPTY_PROJECTION;
    let flight: Promise<void> | null = null;
    let invalidated = false;
    const listeners = new Map<() => void, boolean>();
    const key = computerScopeKey(scope);
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
        // OS permission controls viewing, not whether the daemon still owns a share.
        // Only the owner's selection answer can remove its release affordance.
        publish({ ...snapshot, selection, status: selection.sourceId === snapshot.status?.sourceId ? snapshot.status : null,
            failure: !invalidate && selection.sourceId === snapshot.selection?.sourceId && captureRequired() ? snapshot.failure : null });
    }
    function captureRequired(): boolean {
        return snapshot.failure !== null && resolveComputerRecovery({ kind: 'failed', code: snapshot.failure }, 'use')?.action === 'capture';
    }
    function applySourceFailure(sourceId: string, code: string): void {
        if (!client.isCurrent() || sourceId !== snapshot.selection?.sourceId) return;
        publish({ ...snapshot, failure: code });
    }
    function confirmCapture(sourceId: string): void {
        if (!client.isCurrent() || sourceId !== snapshot.selection?.sourceId) return;
        publish({ ...snapshot, failure: null });
    }
    function applyFailure(code: string): void {
        if (!client.isCurrent()) return;
        const recovery = resolveComputerRecovery({ kind: 'failed', code }, 'use');
        const cause = recovery?.cause;
        // An unreadable observation does not establish that sharing stopped.
        // Retain its release affordance, but withdraw stale control/input facts.
        const selection = cause === 'access_removed' || cause === 'source_lost' ? null : snapshot.selection;
        const grants = recovery?.permission && (cause === 'permission_denied' || cause === 'permission_unknown')
            ? { capture: 'unknown' as const, input: 'unknown' as const, ...snapshot.grants,
                [recovery.permission]: cause === 'permission_denied' ? 'denied' as const : 'unknown' as const }
            : snapshot.grants;
        publish({ ...snapshot, selection, grants, status: null, failure: code });
    }
    function readinessPatch(grants: ComputerTargetsListResponseV1['grants']) {
        return { grants, failure: grants.capture !== 'granted'
            ? grants.capture === 'denied' ? 'capture_permission_denied' : 'capture_permission_unknown'
            : captureRequired() ? snapshot.failure : null };
    }
    function applyReadiness(targets: ComputerTargetsListResponseV1): void {
        if (!client.isCurrent()) return;
        publish({ ...snapshot, ...readinessPatch(targets.grants) });
    }
    function applyStatus(status: ComputerControlStatusResponseV1): void {
        if (!client.isCurrent()) return;
        if (status.sourceId !== snapshot.selection?.sourceId) return;
        // Metadata carries control only; native status reads additionally refresh OS grants.
        const { grants, ...control } = status;
        publish({ ...snapshot, status: control, ...(grants ? readinessPatch(grants) : {}) });
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
                const previousStatus = selection.value.sourceId === snapshot.selection?.sourceId ? snapshot.status : null;
                // Retain the release affordance while status is pending. The retained
                // source reads grants directly; refreshing never needs picker thumbnails.
                applySelection(selection.value, false);
                if (!selection.value.sourceId || !hasDemand()) continue;
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
        applySourceFailure,
        confirmCapture,
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
export function publishComputerStatusFrame(scope: ComputerScope, sourceId: string, frame: MachineLiveStreamFrameV1): void {
    if (frame.payloadKind !== 'metadata') return;
    const mounted = mountedProjections.get(computerScopeKey(scope));
    if (!mounted?.size) return;
    try {
        const parsed = ComputerControlStatusResponseV1Schema.safeParse(JSON.parse(new TextDecoder().decode(decodeBase64(frame.payloadBase64))));
        if (!parsed.success || parsed.data.sourceId !== sourceId) return;
        for (const projection of mounted) projection.applyStatus(parsed.data);
    } catch { /* Malformed metadata never replaces a validated Action/source answer. */ }
}
export type ComputerSessionProjection = ReturnType<typeof createComputerSessionProjection>;

/** A native input refusal is source-owned evidence, not a stream-ending event or a replay request. */
export function publishComputerStreamInputFailure(scope: ComputerScope, sourceId: string, code: string): void {
    if (resolveComputerRecovery({ kind: 'failed', code }, 'use')?.action !== 'capture') return;
    for (const projection of mountedProjections.get(computerScopeKey(scope)) ?? []) projection.applySourceFailure(sourceId, code);
}

export function getComputerSessionProjection(scope: ComputerScope, execute: ComputerActionExecute, accountLifetime?: ServerAccountScopeLifetime | null): ComputerSessionProjection {
    // An unavailable or mismatched binding must not displace a current Account's shared reader.
    if (!createComputerControlClient(scope, execute, accountLifetime).isCurrent()) {
        return createComputerSessionProjection(scope, execute, accountLifetime);
    }
    let scoped = projections.get(execute);
    if (!scoped) projections.set(execute, scoped = new Map());
    const key = computerScopeKey(scope);
    let projection = scoped.get(key);
    if (!projection || projection.accountLifetime !== accountLifetime) {
        scoped.set(key, projection = createComputerSessionProjection(scope, execute, accountLifetime));
    }
    return projection;
}

/** Publish source-owned Action facts to mounted readers; refresh only answers without a final selection fact. */
export function publishComputerActionAnswer(scope: ComputerScope, actionId: string, answer: unknown): void {
    const mounted = mountedProjections.get(computerScopeKey(scope));
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
        if (actionId === 'computer.capture') {
            const capture = ComputerCaptureResponseV1Schema.safeParse(answer);
            if (capture.success && capture.data.status === 'captured') {
                for (const projection of mounted) projection.confirmCapture(capture.data.sourceId);
            } else if (capture.success && capture.data.status === 'failed') {
                for (const projection of mounted) projection.applySourceFailure(capture.data.sourceId, capture.data.code);
            }
        }
        const result = actionId === 'computer.capture' ? ComputerCaptureResponseV1Schema.safeParse(answer) : ComputerActionResultV1Schema.safeParse(answer);
        if (!result.success) return;
        for (const projection of mounted) void projection.refresh(true);
    }
}
