import type {
    BackgroundServiceContext,
    BackgroundServiceDemandHandle,
} from '@happier-dev/plugin-sdk/background-services';

export type BackgroundServiceUnavailableReason = Readonly<{
    code: string;
    hostAccessId: string;
    status: 'denied' | 'unavailable';
}>;

type BackgroundServiceContextCreation = Readonly<{
    context: BackgroundServiceContext;
    complete(): void | Promise<void>;
}> | Readonly<{ unavailable: BackgroundServiceUnavailableReason }>;

export type HostBackgroundServiceContext = Readonly<{
    signal: AbortSignal;
    isOccurrenceCurrent(): boolean;
}>;

/** One placement lifetime for the coalesced batch, joined before settlement. */
export type BackgroundServiceExecution<TContext = BackgroundServiceContext> = Readonly<{
    run(context: TContext): Promise<void>;
    /** Definitive host shutdown, including a child that does not honor abort. */
    stop?(): Promise<void>;
    dispose(): Promise<void>;
    /** Placement-owned proof that no physical resource remains after cleanup. */
    isReleased?(): boolean;
}>;

type ServiceOptions = Readonly<{
    occurrenceId: string;
    localId: string;
    placement?: 'daemon' | 'process';
    activation?: 'continuous' | 'demand';
}>;
export type PluginBackgroundServiceRunnerRegistration = ServiceOptions & Readonly<{
    pluginId: string;
    pluginVersion: string;
    runner(context: BackgroundServiceContext): Promise<void>;
    createExecution?(): BackgroundServiceExecution;
}>;
export type HostBackgroundServiceRunnerRegistration = ServiceOptions & Readonly<{
    owner: Readonly<{ kind: 'host'; serviceId: string }>;
    runner(context: HostBackgroundServiceContext): Promise<void>;
    createExecution?(): BackgroundServiceExecution<HostBackgroundServiceContext>;
}>;
export type BackgroundServiceRunnerRegistration = PluginBackgroundServiceRunnerRegistration | HostBackgroundServiceRunnerRegistration;

type BackgroundServiceIdentity = Readonly<{ occurrenceId: string; localId: string }> & (
    Readonly<{ pluginId: string }>
    | Readonly<{ owner: HostBackgroundServiceRunnerRegistration['owner'] }>
);
export type BackgroundServiceDiagnostic = BackgroundServiceIdentity & (
    Readonly<{ code: 'background_service_failed' | 'background_service_settlement_timeout'; error?: unknown }>
    | Readonly<{ code: 'background_service_unavailable'; reason: BackgroundServiceUnavailableReason }>
);
export type BackgroundServiceDemandTarget = (
    Readonly<{ pluginId: string; localId: string }>
    | Readonly<{ serviceId: string; localId?: string }>
) & Readonly<{ occurrenceId?: string; reason?: string }>;

type DemandCaller = {
    resolve(): void;
    reject(error: unknown): void;
};
type RunningBackgroundService = {
    registration: BackgroundServiceRunnerRegistration;
    controller: AbortController;
    pending: Set<DemandCaller>;
    active: Set<DemandCaller>;
    completed: Set<DemandCaller>;
    stop?: () => Promise<void>;
    releaseFailure?: Readonly<{ error: unknown }>;
    continuous: boolean;
    task: Promise<void>;
};

function cancellationError(message: string): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}
function scopeOf(registration: BackgroundServiceRunnerRegistration): string {
    return 'pluginId' in registration ? registration.pluginId : registration.owner.serviceId;
}

function identityOf(registration: BackgroundServiceRunnerRegistration): BackgroundServiceIdentity {
    return {
        ...('pluginId' in registration ? { pluginId: registration.pluginId } : { owner: registration.owner }),
        occurrenceId: registration.occurrenceId,
        localId: registration.localId,
    };
}

function registrationKey(registration: BackgroundServiceRunnerRegistration): string {
    return 'pluginId' in registration
        ? `plugin\u0000${registration.pluginId}\u0000${registration.localId}`
        : `host\u0000${registration.owner.serviceId}`;
}

export function createBackgroundServiceRunnerHost(params: Readonly<{
    registrations: readonly BackgroundServiceRunnerRegistration[];
    createContext(input: Readonly<{
        pluginId: string;
        pluginVersion: string;
        occurrenceId: string;
        localId: string;
        placement: 'daemon' | 'process';
        signal: AbortSignal;
        isOccurrenceCurrent(): boolean;
    }>): BackgroundServiceContextCreation | Promise<BackgroundServiceContextCreation>;
    settlementTimeoutMs?: number;
    onDiagnostic?(event: BackgroundServiceDiagnostic): void;
}>) {
    const retired = new Set<string>();
    const registrations = new Map<string, BackgroundServiceRunnerRegistration>();
    const running = new Map<string, RunningBackgroundService>();
    let started = false;
    let disposed = false;
    let disposalPromise: Promise<void> | null = null;
    const keyOf = (registration: BackgroundServiceRunnerRegistration): string => `${registrationKey(registration)}\u0000${registration.occurrenceId}`;
    const isCurrent = (registration: BackgroundServiceRunnerRegistration): boolean => !disposed && !retired.has(scopeOf(registration));
    const diagnose = (event: BackgroundServiceDiagnostic): void => {
        try { params.onDiagnostic?.(event); } catch { /* Diagnostics do not own lifecycle. */ }
    };

    async function runBatch(service: RunningBackgroundService): Promise<void> {
        const registration = service.registration;
        if (!isCurrent(registration) || (!service.continuous && service.pending.size === 0)) return;
        do {
            let pluginExecution: BackgroundServiceExecution | undefined;
            let hostExecution: BackgroundServiceExecution<HostBackgroundServiceContext> | undefined;
            try {
                if (registration.placement === 'process') {
                    if (!registration.createExecution) throw new Error('Background process execution is unavailable');
                    if ('pluginId' in registration) pluginExecution = registration.createExecution();
                    else hostExecution = registration.createExecution();
                }
                const execution = pluginExecution ?? hostExecution;
                service.stop = execution?.stop ? () => execution.stop!() : undefined;
                while (isCurrent(registration) && (service.continuous || service.pending.size > 0)) {
                    service.active = service.pending;
                    service.pending = new Set();
                    service.controller = new AbortController();
                    const continuous = service.continuous;
                    service.continuous = false;
                    let complete = (): void | Promise<void> => {};
                    let failed = false;
                    let failure: unknown;
                    let unavailable = false;
                    try {
                        if ('pluginId' in registration) {
                            const creation = params.createContext({
                                pluginId: registration.pluginId,
                                pluginVersion: registration.pluginVersion,
                                occurrenceId: registration.occurrenceId,
                                localId: registration.localId,
                                placement: registration.placement ?? 'daemon',
                                signal: service.controller.signal,
                                isOccurrenceCurrent: () => isCurrent(registration),
                            });
                            const created = creation instanceof Promise ? await creation : creation;
                            if ('unavailable' in created) {
                                unavailable = true;
                                if (isCurrent(registration) && !service.controller.signal.aborted) diagnose({ ...identityOf(registration), code: 'background_service_unavailable', reason: created.unavailable });
                                throw Object.assign(new Error('Background service is unavailable'), { code: created.unavailable.code });
                            }
                            complete = created.complete;
                            if (isCurrent(registration) && !service.controller.signal.aborted) {
                                await (pluginExecution ? pluginExecution.run(created.context) : registration.runner(created.context));
                            }
                        } else {
                            const context = { signal: service.controller.signal, isOccurrenceCurrent: () => isCurrent(registration) };
                            await (hostExecution ? hostExecution.run(context) : registration.runner(context));
                        }
                    } catch (error) {
                        failed = true;
                        failure = error;
                        // Failure settles the admitted batch; a caller's cancellation leaves newer demands intact.
                        if (!service.controller.signal.aborted) {
                            for (const caller of service.pending) caller.reject(error);
                            service.pending.clear();
                        }
                        if (!unavailable && !service.controller.signal.aborted && isCurrent(registration)) diagnose({ ...identityOf(registration), code: 'background_service_failed', error });
                    } finally {
                        const completion = complete();
                        if (completion instanceof Promise) await completion;
                    }
                    for (const caller of service.active) {
                        if (failed) caller.reject(failure);
                        else if (!isCurrent(registration) || service.controller.signal.aborted) caller.reject(cancellationError('Background service demand was cancelled'));
                        else service.completed.add(caller);
                    }
                    service.active.clear();
                    if (continuous || failed || service.controller.signal.aborted) break;
                }
            } catch (error) {
                diagnose({ ...identityOf(registration), code: 'background_service_failed', error });
                for (const caller of [...service.pending, ...service.active, ...service.completed]) caller.reject(error);
                service.pending.clear();
                service.active.clear();
                service.completed.clear();
            } finally {
                try { await (pluginExecution ?? hostExecution)?.dispose(); }
                catch (error) {
                    const execution = pluginExecution ?? hostExecution;
                    if (execution && !execution.isReleased?.()) {
                        service.releaseFailure = { error };
                        service.stop ??= () => execution.dispose();
                    }
                    diagnose({ ...identityOf(registration), code: 'background_service_failed', error });
                    for (const caller of service.completed) caller.reject(error);
                    service.completed.clear();
                    for (const caller of service.pending) caller.reject(error);
                    service.pending.clear();
                }
                if (!service.releaseFailure) service.stop = undefined;
                for (const caller of service.completed) caller.resolve();
                service.completed.clear();
            }
        } while (isCurrent(registration) && service.pending.size > 0);
    }

    function begin(registration: BackgroundServiceRunnerRegistration, continuous: boolean): RunningBackgroundService {
        const key = keyOf(registration);
        const existing = running.get(key);
        if (existing?.releaseFailure) throw existing.releaseFailure.error;
        if (existing) return existing;
        const service: RunningBackgroundService = { registration, controller: new AbortController(), pending: new Set(), active: new Set(), completed: new Set(), continuous, task: Promise.resolve() };
        running.set(key, service);
        service.task = Promise.resolve().then(async () => {
            do { await runBatch(service); } while (isCurrent(registration) && service.pending.size > 0);
            if (running.get(key) === service && !service.releaseFailure) running.delete(key);
        }).finally(() => {
            if (running.get(key) === service && !service.releaseFailure) running.delete(key);
        });
        return service;
    }
    function register(registration: BackgroundServiceRunnerRegistration): void {
        const key = registrationKey(registration);
        if (disposed || registrations.has(key)) throw new Error('Background service registration is unavailable or duplicated');
        registrations.set(key, registration);
        if (started && registration.activation !== 'demand' && isCurrent(registration)) begin(registration, true);
    }
    for (const registration of params.registrations) register(registration);
    function start(): void {
        if (started || disposed) return;
        started = true;
        for (const registration of registrations.values()) {
            if (registration.activation !== 'demand' && isCurrent(registration)) begin(registration, true);
        }
    }
    function demand(target: BackgroundServiceDemandTarget): BackgroundServiceDemandHandle {
        const registration = registrations.get('pluginId' in target
            ? `plugin\u0000${target.pluginId}\u0000${target.localId}`
            : `host\u0000${target.serviceId}`);
        if (!registration || !isCurrent(registration)
            || (target.localId !== undefined && registration.localId !== target.localId)
            || (target.occurrenceId !== undefined && registration.occurrenceId !== target.occurrenceId)) {
            throw new Error('Background service demand targets an unavailable occurrence');
        }
        if (registration.activation !== 'demand') throw new Error('Background service does not declare demand activation');
        const service = begin(registration, false);
        let caller!: DemandCaller;
        const settlement = new Promise<void>((resolve, reject) => { caller = { resolve, reject }; });
        service.pending.add(caller);
        return Object.freeze({ settlement, cancel() {
            const removed = service.pending.delete(caller) || service.active.delete(caller) || service.completed.delete(caller);
            if (!removed) return;
            caller.reject(cancellationError('Background service demand was cancelled'));
            if (service.pending.size === 0 && service.active.size === 0) service.controller.abort(cancellationError('All background service demands were cancelled'));
        } });
    }
    function retire(scopes: readonly string[]): void {
        for (const scope of scopes) retired.add(scope);
        for (const service of running.values()) {
            if (!retired.has(scopeOf(service.registration))) continue;
            const error = cancellationError('Background service occurrence retired');
            for (const caller of [...service.active, ...service.pending, ...service.completed]) caller.reject(error);
            service.active.clear(); service.pending.clear(); service.completed.clear();
            service.controller.abort(error);
        }
    }
    async function waitForSettlement(services: readonly RunningBackgroundService[]): Promise<void> {
        const settlement = Promise.all(services.map((service) => service.task));
        const timeoutMs = params.settlementTimeoutMs;
        if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) { await settlement; return; }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), Math.floor(timeoutMs)); timer.unref?.(); });
        const outcome = await Promise.race([settlement.then(() => 'settled' as const), timeout]);
        if (timer !== undefined) clearTimeout(timer);
        if (outcome === 'timeout') for (const service of services) {
            if (running.has(keyOf(service.registration))) diagnose({ ...identityOf(service.registration), code: 'background_service_settlement_timeout' });
        }
    }
    async function settle(scopes: readonly string[]): Promise<void> {
        const selected = new Set(scopes);
        const services = [...running.values()].filter((service) => selected.has(scopeOf(service.registration)));
        await waitForSettlement(services);
        const failedRelease = services.find((service) => service.releaseFailure)?.releaseFailure;
        if (failedRelease) throw failedRelease.error;
    }
    return Object.freeze({ register, start, demand, retire, settle, dispose(): Promise<void> {
        if (disposalPromise) return disposalPromise;
        disposed = true;
        const scopes = [...new Set([...registrations.values()].map(scopeOf))];
        disposalPromise = (async () => {
            retire(scopes);
            const services = [...running.values()];
            const releases = await Promise.all(services.map(async (service) => {
                const releaseFailure = service.releaseFailure;
                try { await service.stop?.(); }
                catch (error) {
                    diagnose({ ...identityOf(service.registration), code: 'background_service_failed', error });
                    throw error;
                }
                return { service, releaseFailure };
            }));
            await waitForSettlement(services);
            let unconfirmedRelease: RunningBackgroundService['releaseFailure'];
            for (const { service, releaseFailure } of releases) {
                if (!service.releaseFailure) continue;
                if (service.releaseFailure !== releaseFailure) {
                    unconfirmedRelease ??= service.releaseFailure;
                    continue;
                }
                service.releaseFailure = undefined;
                service.stop = undefined;
                if (running.get(keyOf(service.registration)) === service) running.delete(keyOf(service.registration));
            }
            if (unconfirmedRelease) throw unconfirmedRelease.error;
        })().catch((error: unknown) => {
            // Admission stays closed, while an explicit Stop can retry the
            // same execution's failed custody release.
            disposalPromise = null;
            throw error;
        });
        return disposalPromise;
    } });
}
