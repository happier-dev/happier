// @ts-check

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function readJsonBestEffort(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function resolveServerPortFromUiUrl(uiUrl) {
  try {
    const parsed = new URL(String(uiUrl));
    const server = parsed.searchParams.get('server');
    if (!server) return 0;
    const serverUrl = new URL(server);
    const n = Number(serverUrl.port);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

function serverPortFromRuntimeJson(json) {
  const root = json && typeof json === 'object' ? /** @type {any} */ (json) : {};
  const fromRuntime = root.runtime && typeof root.runtime === 'object' ? root.runtime : null;
  const ports = (fromRuntime?.ports ?? root.ports) && typeof (fromRuntime?.ports ?? root.ports) === 'object'
    ? (fromRuntime?.ports ?? root.ports)
    : {};
  const n = Number(ports.server);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function updatedAtMsFromRuntimeJson(json) {
  const root = json && typeof json === 'object' ? /** @type {any} */ (json) : {};
  const raw = root.updatedAt;
  return typeof raw === 'string' ? Date.parse(raw) : 0;
}

export function resolveStackNameFromServerPort({ serverPort, homeDir }) {
  const port = Number(serverPort);
  if (!Number.isFinite(port) || port <= 0) return '';

  const stacksRoot = join(String(homeDir ?? ''), '.happier', 'stacks');
  try {
    const dirents = readdirSync(stacksRoot, { withFileTypes: true });
    let best = { name: '', updatedAtMs: 0 };
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const runtimePath = join(stacksRoot, dirent.name, 'stack.runtime.json');
      const json = readJsonBestEffort(runtimePath);
      if (!json) continue;
      if (serverPortFromRuntimeJson(json) !== port) continue;
      const updatedAtMs = updatedAtMsFromRuntimeJson(json);
      if (updatedAtMs >= best.updatedAtMs) {
        best = { name: dirent.name, updatedAtMs };
      }
    }
    return best.name;
  } catch {
    return '';
  }
}

export function resolveQaStackName({ uiUrl, explicitStackName, homeDir }) {
  const explicit = String(explicitStackName ?? '').trim();
  if (explicit) return explicit;
  const serverPort = resolveServerPortFromUiUrl(uiUrl);
  if (!serverPort) return '';
  return resolveStackNameFromServerPort({ serverPort, homeDir });
}

export function resolveStackCliAccessKeyCandidates({ stackName, homeDir }) {
  const stack = String(stackName ?? '').trim();
  if (!stack) return [];

  const cliRoot = join(String(homeDir ?? ''), '.happier', 'stacks', stack, 'cli');
  const out = [join(cliRoot, 'access.key')];
  const serversDir = join(cliRoot, 'servers');
  try {
    const dirents = readdirSync(serversDir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      out.push(join(serversDir, dirent.name, 'access.key'));
    }
  } catch {
    // ignore
  }
  return out;
}

