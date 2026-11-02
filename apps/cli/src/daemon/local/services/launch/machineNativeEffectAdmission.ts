import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProviderRedactionLease } from '@/providers/spawn/redaction';

export type MachineNativeEffectKey =
    | Readonly<{ kind: 'composeProject'; dockerEndpoint: string; projectName: string }>
    | Readonly<{ kind: 'dockerEngine'; dockerEndpoint: string }>
    | Readonly<{ kind: 'machineSetup' }>;

export type MachineNativeEffectOperation = Readonly<{ operationId: string; kind: string; signal?: AbortSignal }>;

export type MachineNativeEffectStageOptions = Readonly<{
    /** O-DEPLOY 2026-10-31: swap through verify-or-undo is one natural boundary. */
    protected: true;
    onStopPending(status: 'stop_pending'): void;
}>;

export type MachineNativeEffectLogTarget = Readonly<{
    projectName: string; sourcePath: string; composeService: string; containerIds: readonly string[];
}>;
export type MachineNativeEffectLogMasking = Readonly<{
    lease: Pick<ProviderRedactionLease, 'isActive' | 'redact'> | undefined;
    /** Native generation proof, independent of having known launch values. */
    complete: boolean;
}>;

declare const admittedContext: unique symbol;
export type MachineNativeEffectContext = Readonly<{
    [admittedContext]: true;
    operation: MachineNativeEffectOperation;
}>;

export class MachineNativeEffectAdmissionError extends Error {
    readonly code: 'effect_in_progress' | 'admission_unavailable' | 'plan_changed' | 'native_engine_impact_ambiguous';
    readonly actionOperationId: string | undefined;
    readonly details: Readonly<{ actionOperationId: string }> | undefined;
    constructor(code: MachineNativeEffectAdmissionError['code'], actionOperationId?: string) {
        super(code);
        this.name = 'MachineNativeEffectAdmissionError';
        this.code = code;
        this.actionOperationId = actionOperationId;
        this.details = actionOperationId ? { actionOperationId } : undefined;
    }
}

type ActiveEffect = {
    context: MachineNativeEffectContext;
    keys: readonly MachineNativeEffectKey[];
    allNative: boolean;
    pending: Set<Promise<void>>;
    cancellation: AbortController;
    parentSignal?: AbortSignal;
    protectedStage?: ProtectedStage;
    releaseAfterNativeSettlement?: () => void | Promise<void>;
    observeNativeSettlement?: (signal?: AbortSignal) => Promise<boolean>;
    reconciling?: boolean;
    originalFinalized: boolean;
    borrowLogMasking?: (target: MachineNativeEffectLogTarget) => MachineNativeEffectLogMasking | undefined;
    state: 'running' | 'settling' | 'unknown' | 'retired';
};

type ProtectedStage = {
    active: boolean;
    pending: Set<Promise<void>>;
    onStopPending: (status: 'stop_pending') => void;
};
type StageScope = Readonly<{ entry: ActiveEffect; protectedStage?: ProtectedStage }>;
const cancelled = () => Object.assign(new Error('cancelled'), { code: 'cancelled' });

function keyIdentity(key: MachineNativeEffectKey): string {
    switch (key.kind) {
        case 'machineSetup': return JSON.stringify([key.kind]);
        case 'composeProject': return JSON.stringify([key.kind, key.dockerEndpoint, key.projectName]);
        case 'dockerEngine': return JSON.stringify([key.kind, key.dockerEndpoint]);
    }
}

function conflicts(left: MachineNativeEffectKey, right: MachineNativeEffectKey): boolean {
    if (left.kind === 'machineSetup' || right.kind === 'machineSetup') return left.kind === right.kind;
    if (left.dockerEndpoint !== right.dockerEndpoint) return false;
    if (left.kind === 'dockerEngine' || right.kind === 'dockerEngine') return true;
    return keyIdentity(left) === keyIdentity(right);
}

/** One target-daemon owner. Full coordinates are admitted once from the native
 * render. This is native exclusion, independent of Action approval and receipts. */
export function createMachineNativeEffectAdmission() {
    const active = new Set<ActiveEffect>();
    const contexts = new WeakMap<MachineNativeEffectContext, ActiveEffect>();
    // Async scope distinguishes children of the protected boundary from an
    // unstarted sibling using the SAME context. It grants no new admission.
    const stages = new AsyncLocalStorage<StageScope>();
    const read = (context: MachineNativeEffectContext) => {
        const entry = contexts.get(context);
        const scope = stages.getStore();
        if (!entry || entry.state !== 'running' && !(entry.state === 'settling'
            && scope?.entry === entry && scope.protectedStage?.active)) throw new MachineNativeEffectAdmissionError('admission_unavailable');
        return entry;
    };
    const retire = (entry: ActiveEffect) => {
        entry.borrowLogMasking = undefined;
        entry.state = 'retired';
        active.delete(entry);
    };
    const reconcile = async (entry: ActiveEffect, observe: (signal?: AbortSignal) => Promise<boolean>, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (entry.reconciling || !entry.originalFinalized) return;
        // Another retry keeps the existing busy result, not a waiter. The
        // same entry holds its keys throughout proof and native cleanup.
        entry.reconciling = true;
        try {
            if (entry.state !== 'unknown' || !await observe(signal)) return;
            signal?.throwIfAborted();
            await entry.releaseAfterNativeSettlement?.();
            entry.releaseAfterNativeSettlement = undefined;
            entry.observeNativeSettlement = undefined;
            retire(entry);
        } finally { entry.reconciling = false; }
    };
    return {
        /** Borrows the original launch lease; registration never retains it. */
        lendComposeLogMasking(context: MachineNativeEffectContext,
            borrow: NonNullable<ActiveEffect['borrowLogMasking']>): () => void {
            const entry = read(context);
            entry.borrowLogMasking = borrow;
            return () => { if (entry.borrowLogMasking === borrow) entry.borrowLogMasking = undefined; };
        },
        async readComposeLogMasking(target: MachineNativeEffectLogTarget,
            readDockerEndpoint: () => Promise<string | undefined>): Promise<MachineNativeEffectLogMasking | undefined> {
            let engineRead: Promise<string | undefined> | undefined;
            for (const entry of active) {
                if (!entry.keys.some(key => key.kind === 'composeProject' && key.projectName === target.projectName)
                    || !entry.borrowLogMasking?.(target)) continue;
                // A cold tuple can select another Docker engine. Probe only
                // after the live producer recognizes this exact source.
                const dockerEndpoint = await (engineRead ??= readDockerEndpoint());
                if (entry.keys.some(key => key.kind === 'composeProject'
                    && key.projectName === target.projectName && key.dockerEndpoint === dockerEndpoint)) {
                    const masking = entry.borrowLogMasking?.(target);
                    if (masking) return masking;
                }
            }
            return undefined;
        },
        readObservedDockerEngineIds(): readonly string[] {
            // Includes settling/unknown custody, before any event observer has
            // attached and until the canonical native owner retires the effect.
            return [...new Set([...active].flatMap(entry => entry.keys.flatMap(key => 'dockerEndpoint' in key ? [key.dockerEndpoint] : [])))];
        },
        markUnsettled(context: MachineNativeEffectContext, options?: Readonly<{
            releaseAfterNativeSettlement: () => void | Promise<void>;
            /** Producer-retained native proof, using the fresh caller's read lifetime. */
            observeNativeSettlement?: (signal?: AbortSignal) => Promise<boolean>;
        }>): void {
            const entry = contexts.get(context);
            if (!entry || entry.state === 'retired') throw new MachineNativeEffectAdmissionError('admission_unavailable');
            const alreadyUnknown = entry.state === 'unknown';
            const previousObservation = entry.observeNativeSettlement;
            entry.state = 'unknown';
            const observe = options?.observeNativeSettlement;
            // Unknown children without an observation remain unprovable; a
            // later child's proof cannot retire their entire owning effect.
            entry.observeNativeSettlement = observe && (!alreadyUnknown || previousObservation)
                ? previousObservation ? async signal => await previousObservation(signal) && await observe(signal) : observe
                : undefined;
            if (options) {
                const previous = entry.releaseAfterNativeSettlement;
                entry.releaseAfterNativeSettlement = previous ? async () => { await previous(); await options.releaseAfterNativeSettlement(); }
                    : options.releaseAfterNativeSettlement;
            }
        },
        /** Only an explicit second force-stop bypasses the protected boundary. */
        forceStop(context: MachineNativeEffectContext): void {
            read(context).cancellation.abort(cancelled());
        },
        async runStage<T>(context: MachineNativeEffectContext, effect: () => Promise<T>, options?: MachineNativeEffectStageOptions): Promise<T> {
            const entry = read(context);
            const inherited = stages.getStore();
            const protectedStage = inherited?.entry === entry && inherited.protectedStage?.active ? inherited.protectedStage : undefined;
            const work = Promise.resolve().then(async () => {
                if (entry.cancellation.signal.aborted || entry.parentSignal?.aborted && !protectedStage) throw cancelled();
                if (!options?.protected || protectedStage) return stages.run({ entry, ...(protectedStage ? { protectedStage } : {}) }, effect);
                if (entry.protectedStage) throw new MachineNativeEffectAdmissionError('effect_in_progress', context.operation.operationId);
                const boundary: ProtectedStage = { active: true, pending: new Set(), onStopPending: options.onStopPending };
                entry.protectedStage = boundary;
                try { return await stages.run({ entry, protectedStage: boundary }, effect); }
                finally {
                    // The callback cannot abandon a child and thereby move the
                    // natural cancellation boundary ahead of native settlement.
                    while (boundary.pending.size) await Promise.all([...boundary.pending]);
                    boundary.active = false;
                    entry.protectedStage = undefined;
                    if (entry.parentSignal?.aborted) entry.cancellation.abort(entry.parentSignal.reason);
                }
            });
            const settlement = work.then(() => {}, () => {});
            entry.pending.add(settlement);
            protectedStage?.pending.add(settlement);
            void settlement.then(() => { entry.pending.delete(settlement); protectedStage?.pending.delete(settlement); });
            return work;
        },
        async run<T>(input: Readonly<{
            operation: MachineNativeEffectOperation;
            keys: readonly MachineNativeEffectKey[];
            /** Reboot closes this same owner, including effects with no coordinates. */
            allNative?: true;
            /** Existing process/container custody, not a server receipt ACK. */
            settleNative?: () => Promise<void>;
        }>, effect: (context: MachineNativeEffectContext) => Promise<T>): Promise<T> {
            if (input.operation.signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
            const keys = input.keys.map(key => Object.freeze({ ...key }));
            for (const incumbent of active) if (incumbent.state === 'unknown' && incumbent.originalFinalized && incumbent.observeNativeSettlement
                && (input.allNative === true || incumbent.allNative
                    || keys.some(key => incumbent.keys.some(other => conflicts(key, other))))) {
                await reconcile(incumbent, incumbent.observeNativeSettlement, input.operation.signal);
            }
            input.operation.signal?.throwIfAborted();
            // No await between conflict inspection and acquisition: the entire
            // rendered set is admitted atomically, with no partial acquisition.
            for (const incumbent of active) if (input.allNative === true || incumbent.allNative
                || keys.some(key => incumbent.keys.some(other => conflicts(key, other)))) {
                throw new MachineNativeEffectAdmissionError('effect_in_progress', incumbent.context.operation.operationId);
            }
            // This is the admitted owner's forwarding signal, always linked to
            // the real job. It is never a consumer-created recovery signal.
            const cancellation = new AbortController();
            const immediateSignal = input.operation.signal ? AbortSignal.any([input.operation.signal, cancellation.signal]) : cancellation.signal;
            const context = Object.freeze({ operation: Object.freeze({ ...input.operation, get signal() {
                const scope = stages.getStore();
                return scope?.entry === entry && !scope.protectedStage?.active ? immediateSignal : cancellation.signal;
            } }) }) as MachineNativeEffectContext;
            const entry: ActiveEffect = { context, keys, cancellation, parentSignal: input.operation.signal,
                allNative: input.allNative === true, pending: new Set(), state: 'running', originalFinalized: false };
            const onAbort = () => {
                if (entry.protectedStage?.active) entry.protectedStage.onStopPending('stop_pending');
                else cancellation.abort(input.operation.signal?.reason);
            };
            input.operation.signal?.addEventListener('abort', onAbort, { once: true });
            contexts.set(context, entry);
            active.add(entry);
            try { return await effect(context); }
            finally {
                if (entry.state !== 'unknown') entry.state = 'settling';
                try {
                    // A caller may lose its response while a nested native stage
                    // is still running. Cancellation never cancels these waits.
                    while (entry.pending.size) await Promise.all([...entry.pending]);
                    await input.settleNative?.();
                    if (entry.state !== 'unknown') retire(entry);
                } catch (error) {
                    entry.state = 'unknown';
                    throw error;
                } finally {
                    // markUnsettled can precede the original pending/native
                    // drains. A retry stays busy until that finally has exited;
                    // its native proof may then reconcile a failed drain too.
                    entry.originalFinalized = true;
                    input.operation.signal?.removeEventListener('abort', onAbort);
                }
            }
        },
        /** Existing native provenance/receipt owners re-observe uncertain effects;
         * this owner never replays them or treats server settlement as proof. */
        async reconcileUnknown(input: Readonly<{
            keys: readonly MachineNativeEffectKey[];
            observeSettled(operation: MachineNativeEffectOperation): Promise<boolean>;
        }>): Promise<void> {
            for (const entry of active) if (entry.state === 'unknown'
                && input.keys.some(key => entry.keys.some(other => conflicts(key, other)))) {
                await reconcile(entry, async () => input.observeSettled(entry.context.operation));
            }
        },
    };
}

export type MachineNativeEffectAdmission = ReturnType<typeof createMachineNativeEffectAdmission>;
export const machineNativeEffectAdmission = createMachineNativeEffectAdmission();
