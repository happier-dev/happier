import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineVitalsMinuteRecordV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';
import { MachineVitalsAlertEpisodeV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';
import { MachineVitalsAlertsPolicyV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsAlertsV1';
import { MachineVitalsSampleV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { evaluateMachineVitalsAlertsV1 } from '@happier-dev/protocol/machines/vitals/evaluateMachineVitalsAlertsV1';

import { createMinuteHistoryStore } from './minuteHistoryStore';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const minute = (t: number): MachineVitalsMinuteRecordV1 => ({ t, cpu: 20, cpuMax: 50, mem: 10, memMax: 20,
  lvl: 'calm', swp: null, rx: 30, tx: 40 });

describe('minute history store', () => {
  it('persists minute history but never writes or revives alert state across restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-minute-history-'));
    roots.push(directory);
    const now = Date.UTC(2026, 9, 10, 12);
    const store = await createMinuteHistoryStore({ directory, nowMs: () => now });
    const first = { ...minute(now - 240_000), services: [{ serviceId: 'instance/web', cpuPercent: 150, memoryBytes: 1024 }] };
    expect(await store.append(first)).toBe(true);
    const file = join(directory, 'minutes-2026-10-10.jsonl');
    const beforeAlert = await readFile(file, 'utf8');
    const alert = { kind: 'alert' as const, rule: 'memory' as const, state: 'fired' as const, at: now - 120_000 };
    await store.appendAlert(alert);
    expect(store.alerts()).toEqual([alert]);
    expect(await readFile(file, 'utf8')).toBe(beforeAlert);
    expect(await store.append(minute(now - 120_000))).toBe(true);
    expect(await store.append(minute(now - 180_000))).toBe(false);
    await appendFile(file,
      `${JSON.stringify(alert)}\n${JSON.stringify({ kind: 'alert_checkpoint', at: now, episode: alert })}\n${JSON.stringify({ ...minute(now - 60_000), future: 'ignored' })}\n{"bad":true}\n{"t":`);
    const restored = await createMinuteHistoryStore({ directory, nowMs: () => now });
    expect(restored.minutes(0)).toEqual([first, minute(now - 120_000), minute(now - 60_000)]);
    expect(restored.alerts()).toEqual([]);
    expect(await restored.append(minute(now - 180_000))).toBe(false);
    expect(await restored.append(minute(now))).toBe(true);
    expect(await restored.read(now - 60_000)).toEqual([minute(now - 60_000), minute(now)]);
    expect(await readdir(directory)).toEqual(['minutes-2026-10-10.jsonl']);
  });

  it('prunes at startup and day rollover, including cached rows beyond the rolling seven-day window', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-minute-retention-'));
    roots.push(directory);
    let now = Date.UTC(2026, 9, 2, 12);
    const store = await createMinuteHistoryStore({ directory, nowMs: () => now });
    await store.append(minute(now));
    now = Date.UTC(2026, 9, 3, 12);
    await store.append(minute(now));
    now = Date.UTC(2026, 9, 10, 12);
    const restored = await createMinuteHistoryStore({ directory, nowMs: () => now });
    expect(restored.minutes(0)).toEqual([minute(Date.UTC(2026, 9, 3, 12))]);
    expect(await readdir(directory)).toEqual(['minutes-2026-10-03.jsonl']);
    now = Date.UTC(2026, 9, 11);
    await restored.append(minute(now));
    expect(restored.minutes(0)).toEqual([minute(now)]);
    expect(await readdir(directory)).toEqual(['minutes-2026-10-11.jsonl']);
  });

  it('retains runtime suppression and recovery without checkpointing episodes during pruning', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-minute-open-alert-'));
    roots.push(directory);
    let now = Date.UTC(2026, 9, 1);
    const store = await createMinuteHistoryStore({ directory, nowMs: () => now });
    const open = { kind: 'alert' as const, rule: 'disk' as const, volumeId: 'data', state: 'fired' as const, at: now };
    await store.append(minute(now));
    await store.appendAlert(open);
    await store.appendAlert({ ...open, volumeId: 'closed' });
    await store.appendAlert({ ...open, volumeId: 'closed', state: 'recovered', at: now + 60_000 });
    now += 8 * 86_400_000;
    await store.prune();
    expect(store.alerts()).toEqual([open]);
    expect(store.minutes(0)).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
    const policy = MachineVitalsAlertsPolicyV1Schema.parse({ disk: { enabled: true } });
    const sample = MachineVitalsSampleV1Schema.parse({ v: 1, sampledAt: now, intervalMs: 60_000,
      cpu: { reported: false, reason: 'unavailable' }, memory: { reported: false, reason: 'unavailable' },
      network: { reported: false, reason: 'unavailable' }, disk: { reported: true,
        volumes: [{ id: 'data', label: 'Data', mount: '/data', totalBytes: 1000, availableBytes: 0 }] } });
    expect(evaluateMachineVitalsAlertsV1({ policy, now, records: [], episodes: store.alerts(), disk: sample.disk })).toEqual([]);
    const recoveredDisk = MachineVitalsSampleV1Schema.parse({ ...sample, disk: { reported: true,
      volumes: [{ id: 'data', label: 'Data', mount: '/data', totalBytes: 1000, availableBytes: 500 }] } }).disk;
    const recovery = evaluateMachineVitalsAlertsV1({ policy, now, records: [], episodes: store.alerts(), disk: recoveredDisk });
    expect(recovery).toHaveLength(1);
    const recovered = MachineVitalsAlertEpisodeV1Schema.parse(recovery[0].episode);
    expect(recovered).toEqual({ ...open, state: 'recovered', at: now });
    await store.appendAlert(recovered);
    expect(store.alerts().at(-1)).toEqual(recovered);
    const restarted = await createMinuteHistoryStore({ directory, nowMs: () => now });
    expect(restarted.alerts()).toEqual([]);
    expect(evaluateMachineVitalsAlertsV1({ policy, now, records: [], episodes: restarted.alerts(), disk: sample.disk }))
      .toEqual([expect.objectContaining({ episode: { ...open, at: now } })]);
    now += 8 * 86_400_000;
    await store.prune();
    expect(store.alerts()).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });
});
