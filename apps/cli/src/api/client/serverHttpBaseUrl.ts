import { configuration } from '@/configuration';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { existsSync, readFileSync } from 'node:fs';

import { resolveLoopbackHttpUrl } from './loopbackUrl';

function readRuntimeServerUrl(env: NodeJS.ProcessEnv): string | null {
  for (const key of ['HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL'] as const) {
    const rawValue = env[key];
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (value) return value;
  }
  return null;
}

function readEnvFileServerUrl(raw: string): string | null {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'"))
      || (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1).trim();
    }
    if (value) values.set(key, value);
  }
  return values.get('HAPPIER_LOCAL_SERVER_URL')
    ?? values.get('HAPPIER_SERVER_URL')
    ?? values.get('HAPPIER_PUBLIC_SERVER_URL')
    ?? null;
}

function readStackEnvServerUrl(env: NodeJS.ProcessEnv): string | null {
  const path = expandHomeDirPath(String(env.HAPPIER_STACK_ENV_FILE ?? '').trim(), env);
  if (!path || !existsSync(path)) return null;
  try {
    return readEnvFileServerUrl(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function normalizeServerHttpBaseUrl(serverUrl: string): string {
  return resolveLoopbackHttpUrl(serverUrl).replace(/\/+$/, '');
}

export function resolveServerHttpBaseUrl(): string {
  return normalizeServerHttpBaseUrl(
    readRuntimeServerUrl(process.env)
      ?? readStackEnvServerUrl(process.env)
      ?? configuration.apiServerUrl,
  );
}
