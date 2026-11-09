import { MachineVitalsMinuteRecordV1Schema, MachineVitalsMinuteRecordV1StoredReadSchema,
  type MachineVitalsAlertEpisodeV1, type MachineVitalsMinuteRecordV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';

import { createDayPartitionedJsonl } from '../../persistence/dayPartitionedJsonl';

export type MinuteHistoryStore = Readonly<{
  append: (record: MachineVitalsMinuteRecordV1) => Promise<boolean>;
  appendAlert: (episode: MachineVitalsAlertEpisodeV1) => Promise<void>;
  minutes: (sinceMs: number) => readonly MachineVitalsMinuteRecordV1[];
  alerts: () => readonly MachineVitalsAlertEpisodeV1[];
  read: (sinceMs: number) => Promise<readonly MachineVitalsMinuteRecordV1[]>;
  prune: () => Promise<void>;
}>;

export async function createMinuteHistoryStore(input: Readonly<{
  directory: string;
  nowMs?: () => number;
}>): Promise<MinuteHistoryStore> {
  const nowMs = input.nowMs ?? Date.now;
  const retentionMs = 7 * 86_400_000;
  const episodeKey = (episode: MachineVitalsAlertEpisodeV1) => JSON.stringify([episode.rule, episode.volumeId ?? null]);
  const journal = await createDayPartitionedJsonl<MachineVitalsMinuteRecordV1>({ directory: input.directory, prefix: 'minutes', nowMs,
    timestamp: record => record.t,
    parse: (value) => {
      const minute = MachineVitalsMinuteRecordV1StoredReadSchema.safeParse(value);
      return minute.success ? minute.data : null;
    } });
  let records: MachineVitalsMinuteRecordV1[] = [];
  let episodes: MachineVitalsAlertEpisodeV1[] = [];
  let lastMinute = -Infinity;
  // Retired alert/checkpoint rows are ignored; suppression is local to this daemon lifetime.
  for (const row of await journal.read(nowMs() - retentionMs)) {
    if (row.t > lastMinute) {
      records.push(row);
      lastMinute = row.t;
    }
  }
  let lastDay = Math.floor(nowMs() / 86_400_000);
  let pending = Promise.resolve();
  function serialize<R>(operation: () => Promise<R>): Promise<R> {
    const result = pending.then(operation);
    pending = result.then(() => {}, () => {});
    return result;
  }
  function trimCache() {
    const cutoff = nowMs() - retentionMs;
    records = records.filter((record) => record.t >= cutoff);
    const latest = new Map(episodes.map(episode => [episodeKey(episode), episode]));
    episodes = episodes.filter((episode) => episode.at >= cutoff
      || latest.get(episodeKey(episode)) === episode && episode.state === 'fired');
  }
  async function prune() {
    await journal.pruneOlderThan(7);
    trimCache();
    lastDay = Math.floor(nowMs() / 86_400_000);
  }
  async function pruneAtRollover() {
    if (Math.floor(nowMs() / 86_400_000) > lastDay) await prune();
    else trimCache();
  }
  function minutes(sinceMs: number): readonly MachineVitalsMinuteRecordV1[] {
    trimCache();
    return records.filter((record) => record.t >= sinceMs);
  }
  await prune();
  return {
    append: (record) => serialize(async () => {
      const canonical = MachineVitalsMinuteRecordV1Schema.parse(record);
      if (canonical.t <= lastMinute) return false;
      await pruneAtRollover();
      await journal.append(canonical);
      lastMinute = canonical.t;
      records.push(canonical);
      return true;
    }),
    appendAlert: (episode) => serialize(async () => {
      await pruneAtRollover();
      episodes.push(episode);
    }),
    minutes,
    alerts: () => { trimCache(); return episodes.slice(); },
    read: (sinceMs) => serialize(async () => minutes(sinceMs)),
    prune: () => serialize(prune),
  };
}
