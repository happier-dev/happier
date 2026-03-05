import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { DaemonMcpServersDetectWarningV1, DetectedMcpServerV1 } from '@happier-dev/protocol';

export type DetectCodexMcpServersResult = Readonly<{
  servers: ReadonlyArray<DetectedMcpServerV1>;
  warnings: ReadonlyArray<DaemonMcpServersDetectWarningV1>;
}>;

function resolveCodexConfigTomlPath(env: NodeJS.ProcessEnv): string {
  const codexHome = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  if (codexHome) return join(codexHome, 'config.toml');
  return join(homedir(), '.codex', 'config.toml');
}

function normalizeCodexMcpServerName(rawSectionKey: string): string | null {
  const trimmed = rawSectionKey.trim();
  if (!trimmed) return null;

  const firstChar = trimmed[0];
  if (firstChar === '"' || firstChar === "'") {
    const end = trimmed.indexOf(firstChar, 1);
    if (end === -1) return null;
    return trimmed.slice(1, end);
  }

  const firstSegment = trimmed.split('.')[0]?.trim() ?? '';
  return firstSegment ? firstSegment : null;
}

function parseTomlStringLiteral(rawValue: string): string | null {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'") return null;
  const end = trimmed.indexOf(quote, 1);
  if (end === -1) return null;
  return trimmed.slice(1, end);
}

function parseArgsArray(raw: string): string[] | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  const inner = raw.slice(start + 1, end);
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'/g;
  for (;;) {
    const match = re.exec(inner);
    if (!match) break;
    const value = match[1] ?? match[2] ?? '';
    args.push(value);
  }
  return args;
}

type ParsedCodexMcpSection = Readonly<{
  command: string | null;
  args: string[] | null;
  enabled: boolean | null;
}>;

function parseCodexMcpSection(body: string): ParsedCodexMcpSection {
  let command: string | null = null;
  let args: string[] | null = null;
  let enabled: boolean | null = null;

  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();

    if (key === 'command' && command === null) {
      command = parseTomlStringLiteral(value);
      continue;
    }

    if (key === 'args' && args === null) {
      args = parseArgsArray(value);
      continue;
    }

    if (key === 'enabled' && enabled === null) {
      if (value === 'true') enabled = true;
      else if (value === 'false') enabled = false;
      continue;
    }
  }

  return { command, args, enabled };
}

export async function detectCodexMcpServers(params: Readonly<{ env?: NodeJS.ProcessEnv }>): Promise<DetectCodexMcpServersResult> {
  const env = params.env ?? process.env;
  const path = resolveCodexConfigTomlPath(env);
  if (!existsSync(path)) return { servers: [], warnings: [] };

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { servers: [], warnings: [{ provider: 'codex', code: 'read_failed', path }] };
  }

  const servers: DetectedMcpServerV1[] = [];
  const warnings: DaemonMcpServersDetectWarningV1[] = [];

  const re = /^\s*\[mcp_servers\.([^\]]+)\]\s*$/gm;
  const matches: Array<Readonly<{ key: string; headerStart: number; headerEnd: number }>> = [];
  for (;;) {
    const match = re.exec(text);
    if (!match) break;
    matches.push({
      key: match[1] ?? '',
      headerStart: match.index,
      headerEnd: match.index + match[0].length,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const name = normalizeCodexMcpServerName(m.key);
    if (!name) continue;

    const bodyStart = m.headerEnd;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1]!.headerStart : text.length;
    const body = text.slice(bodyStart, bodyEnd);

    const parsed = parseCodexMcpSection(body);
    if (!parsed.command) continue;

    servers.push({
      provider: 'codex',
      name,
      transport: 'stdio',
      stdio: { command: parsed.command, args: parsed.args ?? [] },
      envKeys: [],
      enabled: parsed.enabled,
      source: { kind: 'user', path },
    });
  }

  return { servers, warnings };
}

