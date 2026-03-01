import { Platform } from 'react-native';

export type RestartBugReportIntentV1 = Readonly<{
  v: 1;
  createdAtMs: number;
  reason: 'crash';
}>;

const INTENT_KEY = 'happier_restart_bug_report_intent_v1';
const INTENT_FILENAME = 'restart-bug-report-intent.v1.json';
const MAX_AGE_MS = 30 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}
function parseIntent(raw: string): RestartBugReportIntentV1 | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed.v !== 1) return null;
    if (parsed.reason !== 'crash') return null;
    if (typeof parsed.createdAtMs !== 'number' || !Number.isFinite(parsed.createdAtMs)) return null;
    return parsed as RestartBugReportIntentV1;
  } catch {
    return null;
  }
}

async function readNativeFileSafe(): Promise<string | null> {
  try {
    const FileSystem: any = await import('expo-file-system');
    const base: string | null = FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? null;
    if (!base) return null;
    const path = `${base}${INTENT_FILENAME}`;
    const info = await FileSystem.getInfoAsync(path);
    if (!info?.exists) return null;
    return await FileSystem.readAsStringAsync(path, { encoding: FileSystem.EncodingType.UTF8 });
  } catch {
    return null;
  }
}

async function deleteNativeFileSafe(): Promise<void> {
  try {
    const FileSystem: any = await import('expo-file-system');
    const base: string | null = FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? null;
    if (!base) return;
    const path = `${base}${INTENT_FILENAME}`;
    await FileSystem.deleteAsync(path, { idempotent: true });
  } catch {
    // ignore
  }
}

async function writeNativeFileSafe(payload: string): Promise<void> {
  const FileSystem: any = await import('expo-file-system');
  const base: string | null = FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? null;
  if (!base) return;
  const path = `${base}${INTENT_FILENAME}`;
  await FileSystem.writeAsStringAsync(path, payload, { encoding: FileSystem.EncodingType.UTF8 });
}

export async function persistRestartBugReportIntent(intent: RestartBugReportIntentV1): Promise<void> {
  const payload = JSON.stringify(intent);
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage?.setItem(INTENT_KEY, payload);
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

export async function consumeRestartBugReportIntent(): Promise<boolean> {
  const nowMs = Date.now();
  let raw: string | null = null;

  if (Platform.OS === 'web') {
    try {
      raw = globalThis.localStorage?.getItem(INTENT_KEY) ?? null;
    } catch {
      raw = null;
    }
    if (raw) {
      try {
        globalThis.localStorage?.removeItem(INTENT_KEY);
      } catch {
        // ignore
      }
    }
  } else {
    raw = await readNativeFileSafe();
    await deleteNativeFileSafe();
  }

  if (!raw) return false;
  const parsed = parseIntent(raw);
  if (!parsed) return false;
  if (parsed.createdAtMs < 0) return false;
  if (nowMs - parsed.createdAtMs > MAX_AGE_MS) return false;
  return true;
}
