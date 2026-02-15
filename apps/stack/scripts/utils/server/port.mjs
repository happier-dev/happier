import { readEnvValueFromFile } from '../env/read.mjs';

export const STACK_RESERVED_PORT_KEYS = [
  'HAPPIER_STACK_SERVER_PORT',
  'HAPPIER_STACK_SERVER_BACKEND_PORT',
  'HAPPIER_STACK_PG_PORT',
  'HAPPIER_STACK_REDIS_PORT',
  'HAPPIER_STACK_MINIO_PORT',
  'HAPPIER_STACK_MINIO_CONSOLE_PORT',
];

export const INFRA_RESERVED_PORT_KEYS = [
  'HAPPIER_STACK_SERVER_PORT',
  'HAPPIER_STACK_PG_PORT',
  'HAPPIER_STACK_REDIS_PORT',
  'HAPPIER_STACK_MINIO_PORT',
  'HAPPIER_STACK_MINIO_CONSOLE_PORT',
];

export function coercePort(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function resolveServerPortFromEnv({ env = process.env, defaultPort = 3005 } = {}) {
  const raw = (env.HAPPIER_STACK_SERVER_PORT ?? '').toString().trim() || '';
  const explicitPort = raw ? Number(raw) : NaN;
  if (Number.isFinite(explicitPort) && explicitPort > 0) {
    return explicitPort;
  }

  const serverUrlRaw = (env.HAPPIER_SERVER_URL ?? '').toString().trim();
  if (serverUrlRaw) {
    try {
      const parsed = new URL(serverUrlRaw);
      const urlPort = Number(parsed.port);
      if (Number.isFinite(urlPort) && urlPort > 0) {
        return urlPort;
      }
    } catch {
      // Ignore invalid URL and use the default fallback below.
    }
  }

  const fallback = Number(defaultPort);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 3005;
}

export function listPortsFromEnvObject(env, keys) {
  const obj = env && typeof env === 'object' ? env : {};
  const list = Array.isArray(keys) ? keys : [];
  const out = [];
  for (const k of list) {
    const p = coercePort(obj[k]);
    if (p) out.push(p);
  }
  return out;
}

export async function readServerPortFromEnvFile(envPath, { defaultPort = 3005 } = {}) {
  const v = (await readEnvValueFromFile(envPath, 'HAPPIER_STACK_SERVER_PORT')) || '';
  const n = v ? Number(String(v).trim()) : Number(defaultPort);
  return Number.isFinite(n) && n > 0 ? n : Number(defaultPort);
}

// For stack env files, "missing" means "ephemeral stack" (no pinned port).
export async function readPinnedServerPortFromEnvFile(envPath) {
  const v = (await readEnvValueFromFile(envPath, 'HAPPIER_STACK_SERVER_PORT')) || '';
  const n = v ? Number(String(v).trim()) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
