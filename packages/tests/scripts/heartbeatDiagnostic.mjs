import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const CGROUP_FILES = {
  events: '/sys/fs/cgroup/memory.events',
  localEvents: '/sys/fs/cgroup/memory.events.local',
  current: '/sys/fs/cgroup/memory.current',
  max: '/sys/fs/cgroup/memory.max',
};

export function parseCgroupMemoryEvents(raw) {
  const parsed = {};
  for (const line of String(raw).split('\n')) {
    const [name, value, ...rest] = line.trim().split(/\s+/u);
    if (!name || !value || rest.length > 0) continue;
    const numericValue = Number.parseInt(value, 10);
    if (Number.isSafeInteger(numericValue) && numericValue >= 0) {
      parsed[name] = numericValue;
    }
  }
  return parsed;
}

async function readOptional(path) {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

export async function readCgroupMemorySnapshot() {
  const [eventsRaw, localEventsRaw, current, max] = await Promise.all([
    readOptional(CGROUP_FILES.events),
    readOptional(CGROUP_FILES.localEvents),
    readOptional(CGROUP_FILES.current),
    readOptional(CGROUP_FILES.max),
  ]);
  if (eventsRaw === null && localEventsRaw === null && current === null && max === null) return null;
  return {
    events: eventsRaw === null ? null : parseCgroupMemoryEvents(eventsRaw),
    localEvents: localEventsRaw === null ? null : parseCgroupMemoryEvents(localEventsRaw),
    current,
    max,
  };
}

function diagnosticLine(event) {
  return `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
}

export async function initializeHeartbeatDiagnostic(path, event) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, diagnosticLine(event), 'utf8');
}

export async function appendHeartbeatDiagnostic(path, event) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, diagnosticLine(event), 'utf8');
}

export function resolveOomKillDelta(before, after) {
  const beforeCount = before?.events?.oom_kill;
  const afterCount = after?.events?.oom_kill;
  if (!Number.isSafeInteger(beforeCount) || !Number.isSafeInteger(afterCount)) return null;
  return Math.max(0, afterCount - beforeCount);
}
