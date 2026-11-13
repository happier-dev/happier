import { isDeepStrictEqual } from 'node:util';
import type { MachineVitalsHistoryV1, MachineVitalsHostFactsV1, MachineVitalsMinuteRecordV1, MachineVitalsSampleV1 } from '@happier-dev/protocol';
import { effectiveMachineMemoryPressureV1 } from '@happier-dev/protocol/machines/vitals/effectiveMachineMemoryPressureV1';
import { MachineResourcesPolicyV1Schema, type MachineResourcesPolicyV1 } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import type { MachineServiceUsageV1, MachineVitalsHistoryPointV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';

import { logger } from '@/ui/logger';

import { downsampleMachineVitalsHistory } from './history/downsample';
import type { MinuteHistoryStore } from './history/minuteHistoryStore';
import { createCounterRateReader } from './readers/counterRates';
import type { MachineVitalsMinuteCountersV1, MachineVitalsReader, MachineVitalsReaderResult } from './readers/types';

const MINUTE_MS = 60_000;
const SUMMARY_MS = 15_000;
export const MACHINE_VITALS_LIVE_INTERVAL_MS = 2_000;
const HOUR_MS = 60 * MINUTE_MS;

type TimerHandle = Readonly<{ unref?: () => void }>;
type SampleEvent = Readonly<{ sample: MachineVitalsSampleV1; minute?: MachineVitalsMinuteRecordV1 }>;

export type MachineVitalsSamplerState = { state: 'reporting' } | Extract<MachineVitalsReaderResult, { state: 'unavailable' }>;
export interface MachineVitalsSamplerOptions {
    readers: MachineVitalsReader;
    readServiceUsage?: () => Promise<readonly MachineServiceUsageV1[]>;
    historyStore: MinuteHistoryStore;
    nowMs?: () => number;
    monotonicMs?: () => number;
    setTimeoutFn?: (callback: () => void, delayMs: number) => TimerHandle;
    clearTimeoutFn?: (handle: TimerHandle) => void;
    onError?: (error: unknown) => void;
    onStateChange?: (state: MachineVitalsSamplerState) => void;
    readPolicy?: () => MachineResourcesPolicyV1 | null;
    subscribeMonitoring?: (listener: () => void) => () => void;
    /** Accepted reads, including repeated failures; consumers reuse the sampler clock. */
    onTick?: () => void;
}

export interface MachineVitalsSampler {
    start(): Promise<void>;
    stop(): Promise<void>;
    latest(): MachineVitalsSampleV1 | null;
    host(): MachineVitalsHostFactsV1 | null;
    state(): MachineVitalsSamplerState;
    subscribe(listener: (event: SampleEvent) => void): () => void;
    demand(view: 'summary' | 'live'): () => void;
    demandOverview(): () => void;
    minutes(sinceMs: number): readonly MachineVitalsMinuteRecordV1[];
    samplesSince(cursor: number, view?: 'summary' | 'overview'): readonly MachineVitalsSampleV1[];
    history(range: MachineVitalsHistoryV1['range'], serviceId?: string): MachineVitalsHistoryV1;
}

export function createMachineVitalsSampler(input: MachineVitalsSamplerOptions): MachineVitalsSampler {
    const nowMs = input.nowMs ?? Date.now;
    const monotonicMs = input.monotonicMs ?? (() => performance.now());
    const onError = input.onError ?? ((error: unknown) => logger.debug('[machine vitals] sampling failed', error));
    // The daemon's real clock is Node's; shared UI ambient types also declare a numeric browser timer.
    const setTimeoutFn = input.setTimeoutFn ?? ((callback, delayMs) => {
        const schedule: (callback: () => void, delayMs: number) => NodeJS.Timeout = globalThis.setTimeout;
        return schedule(callback, delayMs);
    });
    const clearTimeoutFn = input.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    const listeners = new Set<(event: SampleEvent) => void>();
    const defaultPolicy = input.readPolicy ? null : MachineResourcesPolicyV1Schema.parse({ v: 1 });
    const readPolicy = input.readPolicy ?? (() => defaultPolicy);
    const ring: Array<Readonly<{ sample: MachineVitalsSampleV1; monotonicAt: number }>> = [];
    let currentState: MachineVitalsSamplerState = { state: 'reporting' };
    let latest: MachineVitalsSampleV1 | null = null;
    let host: MachineVitalsHostFactsV1 | null = null;
    let timer: TimerHandle | null = null;
    let reading: Promise<void> | null = null;
    let lastReadStartedAt: number | null = null;
    let lastReadSampledAt = 0;
    let lastReadIntervalMs: number = MACHINE_VITALS_LIVE_INTERVAL_MS;
    let viewerDepartedAt: number | null = null;
    let running = false;
    let summaries = 0;
    let lives = 0;
    let overviews = 0;
    let releaseMonitoring: (() => void) | null = null;
    let cpuCounterDelta = createCounterRateReader();
    let networkCounterDelta = createCounterRateReader();
    let boundaryAt: number | null = null;
    let lastBucketMinute: number | null = null;
    let bucket: MachineVitalsSampleV1[] = [];

    const samplingAllowed = () => {
        const monitoring = readPolicy()?.monitoring;
        return monitoring !== undefined && monitoring.mode !== 'off'
            && (monitoring.mode === 'always' || lives + summaries + overviews > 0);
    };
    const selectedInterval = () => readPolicy()?.monitoring.intervalMs ?? MACHINE_VITALS_LIVE_INTERVAL_MS;
    const helperFailing = () => currentState.state === 'unavailable' && currentState.reason === 'helper_failing';
    // Three cadences. Nothing visible: one read per wall-clock minute boundary, exactly what the
    // minute history needs. A visible summary: every 15 s on wall-clock quarter-minutes, which
    // include every minute boundary. A Live or Overview viewer: the selected interval.
    const fastViewer = () => lives + overviews > 0 && selectedInterval() < MINUTE_MS;
    const cadence = () => helperFailing() ? Math.max(MINUTE_MS, selectedInterval())
        : fastViewer() ? selectedInterval() : summaries > 0 ? SUMMARY_MS : MINUTE_MS;

    const changeState = (state: MachineVitalsSamplerState) => {
        if (state.state === currentState.state && (state.state === 'reporting'
            || (currentState.state === 'unavailable' && state.reason === currentState.reason))) return;
        currentState = state;
        input.onStateChange?.(state);
    };

    function schedule(): void {
        if (timer) clearTimeoutFn(timer);
        timer = null;
        if (!running || reading || !samplingAllowed()) return;
        const monotonicNow = monotonicMs();
        const interval = cadence();
        let due = lastReadStartedAt === null ? monotonicNow : lastReadStartedAt + interval;
        if (lastReadStartedAt !== null && !helperFailing() && !fastViewer()) {
            // Wall-clock aligned and measured from the last read, so a read overrunning a boundary cannot
            // skip the next one. The prior read's own interval lets a departing viewer's sample settle.
            const boundaryDelay = (Math.floor(lastReadSampledAt / interval) + 1) * interval - nowMs();
            due = Math.min(lastReadStartedAt + lastReadIntervalMs, monotonicNow + Math.min(interval, Math.max(0, boundaryDelay)));
        }
        timer = setTimeoutFn(() => {
            timer = null;
            // Preserve arbitrarily long selected intervals across Node's signed-32 timer chunks.
            if (monotonicMs() < due) schedule();
            else void sample();
        }, Math.min(2_147_483_647, Math.max(0, due - monotonicNow)));
        timer.unref?.();
    }

    function minuteRecord(t: number, counters: MachineVitalsMinuteCountersV1): MachineVitalsMinuteRecordV1 {
        const validMinute = boundaryAt === t - MINUTE_MS;
        const cpuReading: Record<string, number> = counters.containerCpu
            ? { [`usage:${counters.containerCpu.effectiveCores}`]: counters.containerCpu.usageUsec }
            : counters.cpu ? { busy: counters.cpu.busy, total: counters.cpu.total } : {};
        const networkIdentity = counters.network?.interfaceIds.slice().sort().join('\0');
        const networkReading: Record<string, number> = counters.network
            ? { [`rx:${networkIdentity}`]: counters.network.rxBytes, [`tx:${networkIdentity}`]: counters.network.txBytes } : {};
        const cpuDelta = cpuCounterDelta({ monotonicMs: counters.monotonicMs, counters: cpuReading }, MINUTE_MS);
        const networkDelta = networkCounterDelta({ monotonicMs: counters.monotonicMs, counters: networkReading }, MINUTE_MS);
        let cpu: number | null = null;
        let rx: number | null = null;
        let tx: number | null = null;
        if (validMinute) {
            if (cpuDelta && counters.containerCpu && counters.containerCpu.effectiveCores > 0) {
                cpu = Math.min(100, cpuDelta.deltas[`usage:${counters.containerCpu.effectiveCores}`]
                    / (cpuDelta.elapsedMs * 1000 * counters.containerCpu.effectiveCores) * 100);
            } else if (cpuDelta && counters.cpu && cpuDelta.deltas.total > 0) {
                cpu = Math.min(100, cpuDelta.deltas.busy / cpuDelta.deltas.total * 100);
            }
            if (networkDelta && counters.network) {
                // History stores a minute's rate in byte units. A late boundary's
                // actual counter span must not become an inflated per-minute rate.
                rx = networkDelta.deltas[`rx:${networkIdentity}`] * MINUTE_MS / networkDelta.elapsedMs;
                tx = networkDelta.deltas[`tx:${networkIdentity}`] * MINUTE_MS / networkDelta.elapsedMs;
            }
        }
        boundaryAt = t;
        const memories = bucket.flatMap((point) => point.memory.reported ? [point.memory] : []);
        const cpus = bucket.flatMap((point) => point.cpu.reported && point.cpu.busyPct !== null ? [point.cpu.busyPct] : []);
        const pressure = ['not_reported', 'calm', 'elevated', 'critical'] as const;
        const lvl = memories.reduce<MachineVitalsMinuteRecordV1['lvl']>((level, memory) =>
            pressure.indexOf(effectiveMachineMemoryPressureV1(memory)) > pressure.indexOf(level)
                ? effectiveMachineMemoryPressureV1(memory) : level, 'not_reported');
        const swaps = memories.flatMap((memory) => memory.swap ? [memory.swap.usedBytes] : []);
        return {
            t, cpu, cpuMax: cpus.length || cpu !== null ? Math.max(...cpus, cpu ?? 0) : null,
            mem: memories.length ? memories.reduce((sum, memory) => sum + memory.usedBytes, 0) / memories.length : null,
            memMax: memories.length ? Math.max(...memories.map((memory) => memory.usedBytes)) : null,
            lvl, swp: swaps.length ? Math.max(...swaps) : null, rx, tx,
        };
    }

    function sample(): Promise<void> {
        if (reading) return reading;
        if (!samplingAllowed()) return Promise.resolve();
        const run = async () => {
            const sampledAt = nowMs();
            const monotonicAt = monotonicMs();
            // A read within one viewer interval of the viewer leaving (a watch re-arm) is still that
            // viewer's read; a later read settles at the slow cadence once they are really gone.
            const insideViewerRearm = viewerDepartedAt !== null && monotonicAt < viewerDepartedAt + lastReadIntervalMs;
            lastReadStartedAt = monotonicAt;
            const sampledMinute = Math.floor(sampledAt / MINUTE_MS);
            const observedBoundary = lastBucketMinute === null ? sampledAt % MINUTE_MS === 0 ? sampledAt : undefined
                : sampledMinute > lastBucketMinute ? sampledMinute * MINUTE_MS : undefined;
            const intervalMs = insideViewerRearm ? lastReadIntervalMs : cadence();
            lastReadSampledAt = sampledAt;
            lastReadIntervalMs = intervalMs;
            let result: MachineVitalsReaderResult;
            try {
                const policy = readPolicy();
                // Whole-disk scans consume AC for worker sizing as well as scheduled
                // admission. Maintenance remains the sole owner of due times.
                const power = overviews > 0 || policy?.guard.keepAwake === 'on_power'
                    || policy?.storage.wholeDiskEnabled === true;
                result = await input.readers.read({ sampledAt, monotonicMs: monotonicAt, intervalMs, overview: overviews > 0, power, overviewExtras: overviews > 0 });
            } catch (error) {
                onError(error);
                result = { state: 'unavailable', reason: 'reader_failed' };
            }
            // An already-started OS call cannot be recalled, but Off publishes/writes nothing from it.
            if (!samplingAllowed()) return;
            if (result.state === 'unavailable') {
                changeState(result);
                if (observedBoundary !== undefined) {
                    bucket = [];
                    lastBucketMinute = observedBoundary / MINUTE_MS;
                    cpuCounterDelta = createCounterRateReader();
                    networkCounterDelta = createCounterRateReader();
                    boundaryAt = null;
                }
                return;
            }
            changeState({ state: 'reporting' });
            const point = result.sample;
            const firstReading = lastBucketMinute === null;
            latest = point;
            // The reader re-observes static facts on every tick; only changed host facts get a new identity.
            if (!isDeepStrictEqual(host, result.host)) host = result.host;
            ring.push({ sample: point, monotonicAt });
            while (ring.length && ring[0].monotonicAt <= monotonicAt - HOUR_MS) ring.shift();
            const currentMinute = Math.floor((observedBoundary ?? sampledAt) / MINUTE_MS);
            if (lastBucketMinute !== null && currentMinute > lastBucketMinute + 1) bucket = [];
            let minute: MachineVitalsMinuteRecordV1 | undefined;
            const isBoundary = observedBoundary !== undefined;
            if (isBoundary && firstReading) {
                // The first boundary establishes the baseline; it cannot report a preceding minute.
                minuteRecord(observedBoundary, result.minuteCounters);
            } else {
                bucket.push(point);
                if (isBoundary) {
                    const record = minuteRecord(observedBoundary, result.minuteCounters);
                    if (input.readServiceUsage) {
                        try { record.services = [...await input.readServiceUsage()]; }
                        catch (error) { onError(error); }
                    }
                    if (!samplingAllowed()) return;
                    if (await input.historyStore.append(record)) minute = record;
                    bucket = [];
                }
            }
            lastBucketMinute = currentMinute;
            for (const listener of listeners) listener({ sample: point, ...(minute ? { minute } : {}) });
        };
        reading = run().catch(onError).finally(() => {
            reading = null;
            try { if (samplingAllowed()) input.onTick?.(); } catch (error) { onError(error); }
            schedule();
        });
        return reading;
    }

    function demand(view: 'summary' | 'live', overview = false): () => void {
        const wasSampling = samplingAllowed();
        if (overview) overviews++;
        else if (view === 'live') lives++;
        else summaries++;
        if (lives + overviews > 0) viewerDepartedAt = null;
        if (samplingAllowed() !== wasSampling) monitoringChanged();
        else schedule();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const wasSampling = samplingAllowed();
            const hadLiveViewer = lives + overviews > 0;
            if (overview) overviews--;
            else if (view === 'live') lives--;
            else summaries--;
            if (hadLiveViewer && lives + overviews === 0) viewerDepartedAt = monotonicMs();
            if (samplingAllowed() !== wasSampling) monitoringChanged();
            else schedule();
        };
    }

    function monitoringChanged(): void {
        if (!samplingAllowed()) {
            lastReadStartedAt = null;
            boundaryAt = null;
            lastBucketMinute = null;
            bucket = [];
            cpuCounterDelta = createCounterRateReader();
            networkCounterDelta = createCounterRateReader();
        }
        schedule();
    }

    return {
        start: (): Promise<void> => {
            if (running) return reading ?? Promise.resolve();
            running = true;
            releaseMonitoring = input.subscribeMonitoring?.(monitoringChanged) ?? null;
            return sample();
        },
        stop: async (): Promise<void> => {
            running = false;
            if (timer) clearTimeoutFn(timer);
            timer = null;
            releaseMonitoring?.();
            releaseMonitoring = null;
            await reading;
        },
        latest: (): MachineVitalsSampleV1 | null => latest,
        host: (): MachineVitalsHostFactsV1 | null => host,
        state: (): MachineVitalsSamplerState => currentState,
        subscribe: (listener: (event: SampleEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        demand,
        demandOverview: () => demand('live', true),
        minutes: (sinceMs: number) => input.historyStore.minutes(sinceMs),
        samplesSince: (cursor: number, view: 'summary' | 'overview' = 'overview'): readonly MachineVitalsSampleV1[] => {
            // A retained cursor identifies a position in observation order even after a wall-clock step.
            let after = ring.length;
            while (after > 0 && ring[after - 1].sample.sampledAt !== cursor) after--;
            const points = after > 0 ? ring.slice(after) : ring.filter(point => point.sample.sampledAt > cursor);
            if (view === 'overview') return points.map(point => point.sample);
            let previous = after > 0 ? ring[after - 1].monotonicAt : null;
            return points.filter((point) => {
                if (previous !== null && point.monotonicAt - previous < SUMMARY_MS) return false;
                previous = point.monotonicAt;
                return true;
            }).map(point => point.sample);
        },
        history: (range: MachineVitalsHistoryV1['range'], serviceId?: string) => {
            const now = nowMs();
            const livePoints: MachineVitalsHistoryPointV1[] = ring.map(({ sample: point }) => ({
                t: point.sampledAt, cpu: point.cpu.reported ? point.cpu.busyPct : null,
                cpuMax: point.cpu.reported ? point.cpu.busyPct : null,
                mem: point.memory.reported ? point.memory.usedBytes : null,
                memMax: point.memory.reported ? point.memory.usedBytes : null,
                lvl: point.memory.reported ? point.memory.pressure.level : 'not_reported',
                swp: point.memory.reported && point.memory.swap ? point.memory.swap.usedBytes : null,
                rx: point.network.reported && point.network.rxBps !== null ? point.network.rxBps * point.intervalMs / 1000 : null,
                tx: point.network.reported && point.network.txBps !== null ? point.network.txBps * point.intervalMs / 1000 : null,
                ...(point.network.reported && point.network.rxBps !== null ? { rxObservedMs: point.intervalMs } : {}),
                ...(point.network.reported && point.network.txBps !== null ? { txObservedMs: point.intervalMs } : {}),
            }));
            return downsampleMachineVitalsHistory({ records: input.historyStore.minutes(now - 7 * 24 * HOUR_MS), range, now, livePoints, serviceId });
        },
    };
}
