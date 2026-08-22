import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';

import type {
    ContributionRuntimeRegistration,
} from '../../api/registrationRightsHost';

type BackgroundServiceRunner = Extract<
    ContributionRuntimeRegistration,
    { family: 'backgroundServices' }
>['value'];

export type BackgroundServiceUnavailableReason = Readonly<{
    code: string;
    hostAccessId: string;
    status: 'denied' | 'unavailable';
}>;

type BackgroundServiceContextCreation = Readonly<{
    context: BackgroundServiceContext;
    complete(): void;
}> | Readonly<{
    unavailable: BackgroundServiceUnavailableReason;
}>;

export type BackgroundServiceRunnerRegistration = Readonly<{
    pluginId: string;
    pluginVersion: string;
    generation: string;
    localId: string;
    runner: BackgroundServiceRunner;
}>;

type BackgroundServiceDiagnosticBase = Readonly<{
    pluginId: string;
    generation: string;
    localId: string;
}>;

export type BackgroundServiceDiagnostic = BackgroundServiceDiagnosticBase & Readonly<{
    code: 'background_service_failed' | 'background_service_settlement_timeout';
    error?: unknown;
}> | BackgroundServiceDiagnosticBase & Readonly<{
    code: 'background_service_unavailable';
    reason: BackgroundServiceUnavailableReason;
}>;

type RunningBackgroundService = Readonly<{
    registration: BackgroundServiceRunnerRegistration;
    controller: AbortController;
    task: Promise<void>;
}>;

const DEFAULT_SETTLEMENT_TIMEOUT_MS = 5_000;

function positiveSettlementTimeout(value: number | undefined): number {
    return Number.isFinite(value) && value !== undefined && value > 0
        ? Math.floor(value)
        : DEFAULT_SETTLEMENT_TIMEOUT_MS;
}

export function createBackgroundServiceRunnerHost(params: Readonly<{
    registrations: readonly BackgroundServiceRunnerRegistration[];
    createContext(input: Readonly<{
        pluginId: string;
        pluginVersion: string;
        generation: string;
        localId: string;
        signal: AbortSignal;
        isGenerationCurrent(): boolean;
    }>): BackgroundServiceContextCreation;
    settlementTimeoutMs?: number;
    onDiagnostic?(event: BackgroundServiceDiagnostic): void;
}>): Readonly<{
    start(): void;
    retire(pluginIds: readonly string[]): void;
    settle(pluginIds: readonly string[]): Promise<void>;
    dispose(): Promise<void>;
}> {
    const retiredPluginIds = new Set<string>();
    const running = new Map<string, RunningBackgroundService>();
    const settled = new Set<string>();
    let started = false;
    let disposed = false;
    let disposalPromise: Promise<void> | null = null;

    const keyOf = (registration: BackgroundServiceRunnerRegistration): string => (
        `${registration.pluginId}\u0000${registration.generation}\u0000${registration.localId}`
    );
    const isCurrent = (registration: BackgroundServiceRunnerRegistration): boolean => (
        !disposed && !retiredPluginIds.has(registration.pluginId)
    );
    const diagnose = (event: BackgroundServiceDiagnostic): void => {
        try {
            params.onDiagnostic?.(event);
        } catch {
            // Diagnostics are observational and never own service lifecycle.
        }
    };

    function start(): void {
        if (started || disposed) return;
        started = true;
        for (const registration of params.registrations) {
            const key = keyOf(registration);
            if (running.has(key) || retiredPluginIds.has(registration.pluginId)) continue;
            const controller = new AbortController();
            let complete = (): void => {};
            const task = Promise.resolve().then(async () => {
                if (!isCurrent(registration) || controller.signal.aborted) return;
                const created = params.createContext({
                    pluginId: registration.pluginId,
                    pluginVersion: registration.pluginVersion,
                    generation: registration.generation,
                    localId: registration.localId,
                    signal: controller.signal,
                    isGenerationCurrent: () => isCurrent(registration),
                });
                if ('unavailable' in created) {
                    if (!isCurrent(registration) || controller.signal.aborted) return;
                    diagnose(Object.freeze({
                        code: 'background_service_unavailable',
                        pluginId: registration.pluginId,
                        generation: registration.generation,
                        localId: registration.localId,
                        reason: created.unavailable,
                    }));
                    return;
                }
                complete = created.complete;
                if (!isCurrent(registration) || controller.signal.aborted) return;
                await registration.runner(created.context);
            }).catch((error: unknown) => {
                if (controller.signal.aborted) return;
                diagnose(Object.freeze({
                    code: 'background_service_failed',
                    pluginId: registration.pluginId,
                    generation: registration.generation,
                    localId: registration.localId,
                    error,
                }));
            }).finally(() => {
                settled.add(key);
                complete();
            });
            running.set(key, Object.freeze({ registration, controller, task }));
        }
    }

    function retire(pluginIds: readonly string[]): void {
        for (const pluginId of new Set(pluginIds)) {
            retiredPluginIds.add(pluginId);
            for (const service of running.values()) {
                if (service.registration.pluginId !== pluginId || service.controller.signal.aborted) continue;
                service.controller.abort(new Error(
                    `Plugin '${pluginId}' background service generation retired`,
                ));
            }
        }
    }

    async function settle(pluginIds: readonly string[]): Promise<void> {
        const selected = new Set(pluginIds);
        const unsettled = [...running.values()].filter((service) => (
            selected.has(service.registration.pluginId)
        ));
        if (unsettled.length === 0) return;

        const timeoutMs = positiveSettlementTimeout(params.settlementTimeoutMs);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), timeoutMs);
            timer.unref?.();
        });
        const outcome = await Promise.race([
            Promise.all(unsettled.map(async (service) => await service.task)).then(() => 'settled' as const),
            timeout,
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (outcome !== 'timeout') return;

        for (const service of unsettled) {
            if (settled.has(keyOf(service.registration))) continue;
            diagnose(Object.freeze({
                code: 'background_service_settlement_timeout',
                pluginId: service.registration.pluginId,
                generation: service.registration.generation,
                localId: service.registration.localId,
            }));
        }
    }

    return Object.freeze({
        start,
        retire,
        settle,
        dispose() {
            if (disposalPromise) return disposalPromise;
            disposalPromise = (async () => {
                disposed = true;
                const pluginIds = [...new Set(params.registrations.map(({ pluginId }) => pluginId))];
                retire(pluginIds);
                await settle(pluginIds);
            })();
            return disposalPromise;
        },
    });
}
