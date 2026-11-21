import { logger } from '@/ui/logger';
import type { RetainedAgentRuntimePreparation } from '@/plugins/runtime/runner/loadRetainedAgentRuntimeLeaf';

type HostServicePhase = 'external_sessions' | 'managed_provider_binding' | 'team_provider_binding';
type OpenPhaseDetail = Readonly<
    | { parentPhase: 'host_services'; status: 'started' | 'completed' | 'failed' }
    | { factoryInvokedAtMs: number; factoryInvocationMs: number; factoryPreparation?: RetainedAgentRuntimePreparation }
>;

/** One Open phase owner: additive milestones and nested awaits share the same clock and log. */
export function createNativeAgentSessionOpenPhaseRecorder(sessionId: string, intent: string) {
    const startedAt = performance.now();
    let phaseStartedAt = startedAt;
    let factoryInvocation: Readonly<{
        monotonicMs: number;
        wallMs: number;
        preparation?: RetainedAgentRuntimePreparation;
    }> | undefined;
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
            const detail = phase === 'runtime_factory' && factoryInvocation
                ? {
                    factoryInvokedAtMs: factoryInvocation.wallMs,
                    factoryInvocationMs: Math.round(now - factoryInvocation.monotonicMs),
                    ...(factoryInvocation.preparation ? { factoryPreparation: factoryInvocation.preparation } : {}),
                }
                : undefined;
            emit(phase, now, now - phaseStartedAt, detail);
            phaseStartedAt = now;
        },
        markRuntimeFactoryInvoked(preparation?: RetainedAgentRuntimePreparation): void {
            factoryInvocation = { monotonicMs: performance.now(), wallMs: Date.now(), preparation };
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
