import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';

import type { BugReportUserAction } from '@/utils/system/bugReportActionTrail';

export type PreRestartBugReportSnapshotV1 = Readonly<{
  v: 1;
  createdAtMs: number;
  reason: 'crash';
  platform: string;
  origin: string | null;
  isSecureContext: boolean | null;
  errorDetails: string;
  appLogs: string;
  userActions: ReadonlyArray<BugReportUserAction>;
}>;

const SNAPSHOT_KEY = 'happier_pre_restart_bug_report_snapshot_v1';
const SNAPSHOT_FILENAME = 'pre-restart-bug-report-snapshot.v1.json';
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}
function toNullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseSnapshot(raw: string): PreRestartBugReportSnapshotV1 | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed.v !== 1) return null;
    if (parsed.reason !== 'crash') return null;
    if (typeof parsed.createdAtMs !== 'number' || !Number.isFinite(parsed.createdAtMs)) return null;

    const platform = toNullableString(parsed.platform) ?? 'unknown';
    const origin = toNullableString(parsed.origin);
    const isSecureContext =
      typeof parsed.isSecureContext === 'boolean' ? parsed.isSecureContext : parsed.isSecureContext === null ? null : null;
    const errorDetails = typeof parsed.errorDetails === 'string' ? parsed.errorDetails : '';
    const appLogs = typeof parsed.appLogs === 'string' ? parsed.appLogs : '';
    const userActions =
      Array.isArray(parsed.userActions) ? parsed.userActions.filter((a) => isRecord(a)) as BugReportUserAction[] : [];

    return {
      v: 1,
      createdAtMs: parsed.createdAtMs as number,
      reason: 'crash',
      platform,
      origin,
      isSecureContext,
      errorDetails,
      appLogs,
      userActions,
    };
  } catch {
    return null;
  }
}

async function readNativeFileSafe(): Promise<string | null> {
  try {
    const file = getNativeFile();
    if (!file?.exists) return null;
    return await file.text();
  } catch {
    return null;
  }
}

async function writeNativeFileSafe(payload: string): Promise<void> {
  const file = getNativeFile();
  if (!file) return;
  file.write(payload);
}

async function deleteNativeFileSafe(): Promise<void> {
  try {
    const file = getNativeFile();
    if (file?.exists) file.delete();
  } catch {
    // ignore
  }
}

function getNativeFile(): File | null {
  try {
    return new File(Paths.cache, SNAPSHOT_FILENAME);
  } catch {
    try {
      return new File(Paths.document, SNAPSHOT_FILENAME);
    } catch {
      return null;
    }
  }
}

export async function persistPreRestartBugReportSnapshot(snapshot: PreRestartBugReportSnapshotV1): Promise<void> {
  const payload = JSON.stringify(snapshot);
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage?.setItem(SNAPSHOT_KEY, payload);
    } catch {
      // ignore
    }
    return;
  }

  try {
    await writeNativeFileSafe(payload);
  } catch {
    // ignore
  }
}

export async function peekPreRestartBugReportSnapshot(): Promise<PreRestartBugReportSnapshotV1 | null> {
  const nowMs = Date.now();
  let raw: string | null = null;

  if (Platform.OS === 'web') {
    try {
      raw = globalThis.localStorage?.getItem(SNAPSHOT_KEY) ?? null;
    } catch {
      raw = null;
    }
  } else {
    raw = await readNativeFileSafe();
  }

  if (!raw) return null;
  const parsed = parseSnapshot(raw);
  if (!parsed) {
    await clearPreRestartBugReportSnapshot();
    return null;
  }

  if (parsed.createdAtMs < 0 || nowMs - parsed.createdAtMs > MAX_AGE_MS) {
    await clearPreRestartBugReportSnapshot();
    return null;
  }

  return parsed;
}

export async function clearPreRestartBugReportSnapshot(): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage?.removeItem(SNAPSHOT_KEY);
    } catch {
      // ignore
    }
    return;
  }

  await deleteNativeFileSafe();
}
