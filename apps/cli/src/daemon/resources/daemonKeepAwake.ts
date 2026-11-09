import type { MachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createKeepAwake, type KeepAwake } from '@/integrations/keepAwake';
import { logger } from '@/ui/logger';
import type { MachineResourcesPolicyRuntime } from './machineResourcesPolicy';

/** Resources metadata is the sole mode authority; vitals supplies actual AC changes for On power. */
export function createDaemonKeepAwake(input: Readonly<{
    policy: Pick<MachineResourcesPolicyRuntime, 'read' | 'subscribe'>;
    vitals: Pick<MachineVitalsSampler, 'latest' | 'subscribe'>;
    holder?: KeepAwake;
}>) {
    const holder = input.holder ?? createKeepAwake();
    let releaseVitals: (() => void) | null = null;
    let stopped = false;
    const readAC = () => input.vitals.latest()?.power?.onAC ?? null;
    const refresh = async () => {
        if (stopped) return;
        const snapshot = input.policy.read();
        const mode = snapshot.status === 'ready' ? snapshot.policy.guard.keepAwake : 'off';
        if (mode === 'on_power' && !releaseVitals) {
            let previous = readAC();
            releaseVitals = input.vitals.subscribe(() => {
                const next = readAC();
                const powerChanged = next !== previous;
                previous = next;
                if (powerChanged) void refresh().catch(error => logger.warn('[keep awake] Reconciliation failed', error));
            });
        } else if (mode !== 'on_power') { releaseVitals?.(); releaseVitals = null; }
        await holder.update(mode, readAC());
    };
    const releasePolicy = input.policy.subscribe(() => {
        void refresh().catch(error => logger.warn('[keep awake] Policy change failed', error));
    });
    return { read: holder.read, subscribe: holder.subscribe, start: refresh,
        async stop() { stopped = true; releasePolicy(); releaseVitals?.(); releaseVitals = null; await holder.release(); } };
}
