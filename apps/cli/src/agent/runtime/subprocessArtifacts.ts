import { mkdir } from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

function sanitizePathSegment(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '') || 'unknown';
}

function sanitizeEnvKeySegment(value: string): string {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '') || 'UNKNOWN';
}

function parseEnvBoundedInt(name: string, opts: Readonly<{ min: number; max: number; fallback: number }>): number {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim().length === 0) return opts.fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return opts.fallback;
  return Math.min(opts.max, Math.max(opts.min, parsed));
}

export type BoundedTextFileAppender = Readonly<{
  path: string;
  append: (text: string) => void;
  close: () => Promise<void>;
}>;

export function resolveSubprocessArtifactsDir(params: Readonly<{
  agentName: string;
  envOverrides?: ReadonlyArray<string>;
}>): string {
  const agentName = sanitizePathSegment(params.agentName);
  const upper = sanitizeEnvKeySegment(params.agentName);

  const perAgentKey = `HAPPIER_${upper}_DEBUG_ARTIFACTS_DIR`;
  const overrideKeys = [perAgentKey, ...(params.envOverrides ?? [])];
  for (const key of overrideKeys) {
    const raw = process.env[key];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim();
    }
  }

  const globalRoot = process.env.HAPPIER_DEBUG_ARTIFACTS_DIR;
  if (typeof globalRoot === 'string' && globalRoot.trim().length > 0) {
    return join(globalRoot.trim(), 'subprocess', agentName);
  }

  return join(configuration.happyHomeDir, 'cli', 'logs', 'subprocess', agentName);
}

export async function createBoundedTextFileAppender(params: Readonly<{
  filePath: string;
  maxBytes: number;
}>): Promise<BoundedTextFileAppender> {
  await mkdir(dirname(params.filePath), { recursive: true });

  let stream: WriteStream | null = createWriteStream(params.filePath, { flags: 'a', mode: 0o600 });
  let bytesWritten = 0;
  let truncationWritten = false;
  const maxBytes = Math.max(0, Math.floor(params.maxBytes));

  const append = (text: string) => {
    if (!stream) return;
    if (!text) return;

    const buf = Buffer.from(String(text));
    if (maxBytes > 0 && bytesWritten >= maxBytes) {
      if (!truncationWritten) {
        truncationWritten = true;
        try {
          stream.write('\n...[truncated]\n');
        } catch {
          // ignore
        }
      }
      return;
    }

    const remaining = maxBytes > 0 ? Math.max(0, maxBytes - bytesWritten) : buf.length;
    const slice = maxBytes > 0 ? buf.subarray(0, remaining) : buf;
    bytesWritten += slice.length;
    try {
      stream.write(slice);
    } catch {
      // ignore
    }
  };

  const close = async () => {
    const s = stream;
    stream = null;
    if (!s) return;
    await new Promise<void>((resolve) => s.end(resolve));
  };

  return { path: params.filePath, append, close };
}

export async function createSubprocessStderrAppender(params: Readonly<{
  agentName: string;
  pid: number | null;
  label: string;
  envOverrides?: ReadonlyArray<string>;
}>): Promise<BoundedTextFileAppender | null> {
  const enabledRaw = process.env.HAPPIER_SUBPROCESS_ARTIFACTS_ENABLED;
  if (typeof enabledRaw === 'string' && ['0', 'false', 'no'].includes(enabledRaw.trim().toLowerCase())) {
    return null;
  }

  const maxBytes = parseEnvBoundedInt('HAPPIER_SUBPROCESS_STDERR_MAX_BYTES', { min: 0, max: 10_000_000, fallback: 1_000_000 });
  if (maxBytes === 0) return null;
  const dir = resolveSubprocessArtifactsDir({ agentName: params.agentName, envOverrides: params.envOverrides });
  try {
    await mkdir(dir, { recursive: true });
    const stamp = Date.now();
    const pidSuffix = typeof params.pid === 'number' && Number.isFinite(params.pid) ? `-pid-${params.pid}` : '';
    const filePath = join(dir, `${sanitizePathSegment(params.label)}-stderr-${stamp}${pidSuffix}.log`);
    return await createBoundedTextFileAppender({ filePath, maxBytes });
  } catch (error) {
    logger.debug('[subprocessArtifacts] Failed to create stderr appender (non-fatal)', error);
    return null;
  }
}
