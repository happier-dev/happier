import { readEnvValueFromFile } from '../env/read.mjs';

export const STACK_RESERVED_PORT_KEYS = [
  'HAPPY_STACKS_SERVER_PORT',
  'HAPPY_LOCAL_SERVER_PORT',
  'HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT',
  'HAPPY_LOCAL_HAPPY_SERVER_BACKEND_PORT',
  'HAPPY_STACKS_PG_PORT',
  'HAPPY_STACKS_REDIS_PORT',
  'HAPPY_STACKS_MINIO_PORT',
  'HAPPY_STACKS_MINIO_CONSOLE_PORT',
];

export const INFRA_RESERVED_PORT_KEYS = [
  'HAPPY_STACKS_SERVER_PORT',
  'HAPPY_LOCAL_SERVER_PORT',
  'HAPPY_STACKS_PG_PORT',
  'HAPPY_STACKS_REDIS_PORT',
  'HAPPY_STACKS_MINIO_PORT',
  'HAPPY_STACKS_MINIO_CONSOLE_PORT',
];

export function coercePort(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function resolveServerPortFromEnv({ env = process.env, defaultPort = 3005 } = {}) {
  const raw =
    (env.HAPPY_STACKS_SERVER_PORT ?? '').toString().trim() ||
    (env.HAPPY_LOCAL_SERVER_PORT ?? '').toString().trim() ||
    '';
  const n = raw ? Number(raw) : Number(defaultPort);
  return Number.isFinite(n) && n > 0 ? n : Number(defaultPort);
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
  const v =
    (await readEnvValueFromFile(envPath, 'HAPPY_STACKS_SERVER_PORT')) ||
    (await readEnvValueFromFile(envPath, 'HAPPY_LOCAL_SERVER_PORT')) ||
    '';
  const n = v ? Number(String(v).trim()) : Number(defaultPort);
  return Number.isFinite(n) && n > 0 ? n : Number(defaultPort);
}

// For stack env files, "missing" means "ephemeral stack" (no pinned port).
export async function readPinnedServerPortFromEnvFile(envPath) {
  const v =
    (await readEnvValueFromFile(envPath, 'HAPPY_STACKS_SERVER_PORT')) ||
    (await readEnvValueFromFile(envPath, 'HAPPY_LOCAL_SERVER_PORT')) ||
    '';
  const n = v ? Number(String(v).trim()) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

