import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { readTextOrEmpty } from '../utils/fs/ops.mjs';
import { isTcpPortFree, pickNextFreeTcpPort } from '../utils/net/ports.mjs';
import { getStacksStorageRoot } from '../utils/paths/paths.mjs';
import { parseEnvToObject } from '../utils/env/dotenv.mjs';
import { coercePort, listPortsFromEnvObject, readPinnedServerPortFromEnvFile, STACK_RESERVED_PORT_KEYS } from '../utils/server/port.mjs';

const readExistingEnv = readTextOrEmpty;

export function getDefaultPortStart(stackName = null) {
  const raw = process.env.HAPPIER_STACK_STACK_PORT_START?.trim() ? process.env.HAPPIER_STACK_STACK_PORT_START.trim() : '';
  // Default port strategy:
  // - main historically lives at 3005
  // - non-main stacks should avoid 3005 to reduce accidental collisions/confusion
  const target = (stackName ?? '').toString().trim() || (process.env.HAPPIER_STACK_STACK ?? '').trim() || 'main';
  const fallback = target === 'main' ? 3005 : 3009;
  const n = raw ? Number(raw) : fallback;
  return Number.isFinite(n) ? n : fallback;
}

export async function isPortFree(port, { host = '127.0.0.1' } = {}) {
  return await isTcpPortFree(port, { host });
}

export async function pickNextFreePort(startPort, { reservedPorts = new Set(), host = '127.0.0.1' } = {}) {
  try {
    return await pickNextFreeTcpPort(startPort, { reservedPorts, host });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(msg.replace(/^\[local\]/, '[stack]'));
  }
}

export async function readPortFromEnvFile(envPath) {
  return await readPinnedServerPortFromEnvFile(envPath);
}

async function readPortsFromEnvFile(envPath) {
  const raw = await readExistingEnv(envPath);
  if (!raw.trim()) return [];
  const parsed = parseEnvToObject(raw);
  return listPortsFromEnvObject(parsed, STACK_RESERVED_PORT_KEYS);
}

export async function collectReservedStackPorts({ excludeStackName = null } = {}) {
  const reserved = new Set();
  const roots = [getStacksStorageRoot()];

  for (const root of roots) {
    let entries = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (excludeStackName && name === excludeStackName) continue;
      const envPath = join(root, name, 'env');
      // eslint-disable-next-line no-await-in-loop
      const ports = await readPortsFromEnvFile(envPath);
      for (const port of ports) {
        const coerced = coercePort(port);
        if (coerced) reserved.add(coerced);
      }
    }
  }

  return reserved;
}
