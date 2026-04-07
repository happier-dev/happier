import type { ScheduledTaskStatus } from './serviceDiscoveryTypes.js';

function parseIntOrNull(value: string | undefined): number | null {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function parseBooleanFromText(value: string | null | undefined): boolean | null {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text === 'enabled' || text === 'running') return true;
  if (text === 'disabled' || text === 'ready' || text === 'stopped') return false;
  return null;
}

export function readScheduledTaskStatus(params: Readonly<{
  output: string;
}>): ScheduledTaskStatus {
  const values: Record<string, string> = {};
  for (const line of String(params.output ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([^:]+):\s*(.*)$/u.exec(trimmed);
    if (!match) continue;
    values[String(match[1] ?? '').trim()] = String(match[2] ?? '').trim();
  }

  const scheduledTaskState = values['Scheduled Task State'] ?? null;
  const status = values.Status ?? null;

  return {
    taskName: values.TaskName ?? null,
    scheduledTaskState,
    status,
    enabled: parseBooleanFromText(scheduledTaskState),
    running: parseBooleanFromText(status),
    lastRunTime: values['Last Run Time'] ?? null,
    nextRunTime: values['Next Run Time'] ?? null,
    lastResult: parseIntOrNull(values['Last Result']),
    taskToRun: values['Task To Run'] ?? null,
  };
}
