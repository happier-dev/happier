import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';

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
    const file = getNativeFile();
    if (!file?.exists) return null;
    return await file.text();
  } catch {
    return null;
  }
}

async function deleteNativeFileSafe(): Promise<void> {
  try {
    const file = getNativeFile();
    if (file?.exists) file.delete();
  } catch {
    // ignore
  }
}

async function writeNativeFileSafe(payload: string): Promise<void> {
  const file = getNativeFile();
  if (!file) return;
  file.write(payload);
}

function getNativeFile(): File | null {
  try {
    return new File(Paths.cache, INTENT_FILENAME);
  } catch {
    try {
      return new File(Paths.document, INTENT_FILENAME);
    } catch {
      return null;
    }
  }
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
