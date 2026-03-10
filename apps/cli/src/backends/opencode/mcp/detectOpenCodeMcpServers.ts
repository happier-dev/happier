import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { DaemonMcpServersDetectWarningV1, DetectedMcpServerV1 } from '@happier-dev/protocol';

export type DetectOpenCodeMcpServersResult = Readonly<{
  servers: ReadonlyArray<DetectedMcpServerV1>;
  warnings: ReadonlyArray<DaemonMcpServersDetectWarningV1>;
}>;

function resolveXdgConfigHome(env: NodeJS.ProcessEnv): string {
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME.trim() : '';
  if (xdg) return xdg;
  return join(homedir(), '.config');
}

function safeReadJson(path: string): { ok: true; value: unknown } | { ok: false; warning: DaemonMcpServersDetectWarningV1 } {
  try {
    const raw = readFileSync(path, 'utf8');
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, warning: { provider: 'opencode', code: 'parse_failed', path } };
  }
}

function readOpenCodeMcpServersFromConfig(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as any;
  const direct = root.mcpServers;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  const legacy = root.mcp_servers;
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) return legacy;
  return null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry);
  }
  return out;
}

function normalizeRecordKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>);
}

function normalizeDetectedServer(params: Readonly<{
  name: string;
  config: unknown;
  source: DetectedMcpServerV1['source'];
}>): DetectedMcpServerV1 | null {
  const cfg = params.config;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  const obj = cfg as any;

  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : null;

  const command = typeof obj.command === 'string' && obj.command.trim().length > 0 ? obj.command.trim() : null;
  const args = normalizeStringArray(obj.args);
  const envKeys = normalizeRecordKeys(obj.env);

  if (command) {
    return {
      provider: 'opencode',
      name: params.name,
      transport: 'stdio',
      stdio: { command, args },
      envKeys,
      enabled,
      source: params.source,
    };
  }

  const urlRaw = typeof obj.url === 'string' ? obj.url : typeof obj.endpoint === 'string' ? obj.endpoint : null;
  const url = urlRaw && urlRaw.trim().length > 0 ? urlRaw.trim() : null;
  if (!url) return null;

  const transport = obj.transport === 'sse' || obj.type === 'sse' ? 'sse' : 'http';
  const headerKeys = normalizeRecordKeys(obj.headers);
  return {
    provider: 'opencode',
    name: params.name,
    transport,
    remote: { url, headers: headerKeys },
    envKeys,
    enabled,
    source: params.source,
  };
}

export async function detectOpenCodeMcpServers(params: Readonly<{
  directory: string | null;
  env?: NodeJS.ProcessEnv;
}>): Promise<DetectOpenCodeMcpServersResult> {
  const env = params.env ?? process.env;
  const xdg = resolveXdgConfigHome(env);

  const candidates: Array<Readonly<{ kind: 'user' | 'project'; path: string }>> = [
    { kind: 'user', path: join(xdg, 'opencode', 'opencode.json') },
  ];

  if (typeof params.directory === 'string' && params.directory.trim().length > 0) {
    const root = params.directory.trim();
    candidates.push({ kind: 'project', path: join(root, '.opencode', 'opencode.json') });
  }

  const servers: DetectedMcpServerV1[] = [];
  const warnings: DaemonMcpServersDetectWarningV1[] = [];

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    const parsed = safeReadJson(candidate.path);
    if (!parsed.ok) {
      warnings.push(parsed.warning);
      continue;
    }

    const rawServers = readOpenCodeMcpServersFromConfig(parsed.value);
    if (!rawServers || typeof rawServers !== 'object' || Array.isArray(rawServers)) continue;

    for (const [nameRaw, config] of Object.entries(rawServers as Record<string, unknown>)) {
      const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
      if (!name) continue;
      const detected = normalizeDetectedServer({
        name,
        config,
        source: { kind: candidate.kind, path: candidate.path },
      });
      if (!detected) continue;
      servers.push(detected);
    }
  }

  return { servers, warnings };
}

