import { logger } from '@/ui/logger';

type HostServicePhase = 'external_sessions' | 'managed_provider_binding' | 'team_provider_binding';
type OpenPhaseDetail = Readonly<
    | { parentPhase: 'host_services'; status: 'started' | 'completed' | 'failed' }
    | { factoryInvokedAtMs: number; factoryInvocationMs: number }
>;

/** One Open phase owner: additive milestones and nested awaits share the same clock and log. */
export function createNativeAgentSessionOpenPhaseRecorder(sessionId: string, intent: string) {
    const startedAt = performance.now();
    let phaseStartedAt = startedAt;
    let factoryInvokedAt: Readonly<{ monotonicMs: number; wallMs: number }> | undefined;
    const emit = (phase: string, now: number, durationMs: number, detail?: OpenPhaseDetail) => {
        logger.infoFile('[NativeAgentSession] Open phase', {
            phase, sessionId, intent,
            durationMs: Math.round(durationMs), elapsedMs: Math.round(now - startedAt),
            ...detail,
        });
    };
    return {
        record(phase: string): void {
            const now = performance.now();
            const detail = phase === 'runtime_factory' && factoryInvokedAt
                ? {
                    factoryInvokedAtMs: factoryInvokedAt.wallMs,
                    factoryInvocationMs: Math.round(now - factoryInvokedAt.monotonicMs),
                }
                : undefined;
            emit(phase, now, now - phaseStartedAt, detail);
            phaseStartedAt = now;
        },
        markRuntimeFactoryInvoked(): void {
            factoryInvokedAt = { monotonicMs: performance.now(), wallMs: Date.now() };
        },
        async measureHostService<T>(phase: HostServicePhase, work: () => Promise<T>): Promise<T> {
            const phaseStart = performance.now();
            emit(phase, phaseStart, 0, { parentPhase: 'host_services', status: 'started' });
            try {
                const result = await work();
                const now = performance.now();
                emit(phase, now, now - phaseStart, { parentPhase: 'host_services', status: 'completed' });
                return result;
            } catch (error) {
                const now = performance.now();
                emit(phase, now, now - phaseStart, { parentPhase: 'host_services', status: 'failed' });
                throw error;
            }
        },
    };
}
