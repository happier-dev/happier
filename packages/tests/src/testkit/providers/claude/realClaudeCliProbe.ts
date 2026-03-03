import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export type RealClaudeToolUseBlock = { toolUseId: string | null; name: string; input: unknown };
export type RealClaudeToolResultBlock = { toolUseId: string | null; result: unknown };

export type RealClaudeStreamJsonProbeResult = {
  sessionId: string | null;
  agentIds: string[];
  initTools: string[];
  toolUseNames: string[];
  toolUses: RealClaudeToolUseBlock[];
  toolResults: RealClaudeToolResultBlock[];
  stdoutTail: string[];
  stderrTail: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export function extractSessionIdFromStreamJsonLine(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const record = obj as Record<string, unknown>;
  const raw = record.session_id ?? (record as any).sessionId;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extractInitToolsFromStreamJsonLine(obj: unknown): string[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const record = obj as Record<string, unknown>;
  if (record.type !== 'system' || record.subtype !== 'init') return [];
  const tools = record.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter(Boolean);
}

export function extractToolUseNamesFromStreamJsonLine(obj: unknown): string[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const record = obj as Record<string, unknown>;
  if (record.type !== 'assistant') return [];

  const message = record.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return [];
  const content = (message as any).content as unknown;
  if (!Array.isArray(content)) return [];

  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_use') continue;
    if (typeof b.name === 'string' && b.name.trim().length > 0) out.push(b.name.trim());
  }
  return out;
}

export function extractToolUseBlocksFromStreamJsonLine(obj: unknown): RealClaudeToolUseBlock[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const record = obj as Record<string, unknown>;
  if (record.type !== 'assistant') return [];

  const message = record.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return [];
  const content = (message as any).content as unknown;
  if (!Array.isArray(content)) return [];

  const out: RealClaudeToolUseBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_use') continue;
    const toolUseId =
      typeof (b as any).id === 'string'
        ? String((b as any).id).trim() || null
        : typeof (b as any).tool_use_id === 'string'
          ? String((b as any).tool_use_id).trim() || null
          : null;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) continue;
    out.push({ toolUseId, name, input: (b as any).input });
  }
  return out;
}

export function extractToolResultBlocksFromStreamJsonLine(obj: unknown): RealClaudeToolResultBlock[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const record = obj as Record<string, unknown>;
  if (record.type !== 'user') return [];

  const message = record.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return [];
  const content = (message as any).content as unknown;
  if (!Array.isArray(content)) return [];

  const out: RealClaudeToolResultBlock[] = [];
  const toolUseResult = (record as any).tool_use_result as unknown;
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_result') continue;
    const toolUseId = typeof (b as any).tool_use_id === 'string' ? String((b as any).tool_use_id) : null;
    out.push({
      toolUseId,
      result: {
        content: (b as any).content,
        ...(toolUseResult !== undefined ? { tool_use_result: toolUseResult } : {}),
      },
    });
  }
  return out;
}

export function extractAgentIdsFromStreamJsonLine(obj: unknown): string[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const record = obj as any;
  if (record.type !== 'user') return [];
  const toolUseResult = record.tool_use_result;
  if (!toolUseResult || typeof toolUseResult !== 'object' || Array.isArray(toolUseResult)) return [];

  const agentIdRaw = (toolUseResult as any).agent_id ?? (toolUseResult as any).agentId ?? (toolUseResult as any).teammate_id;
  const agentId = typeof agentIdRaw === 'string' ? agentIdRaw.trim() : '';
  return agentId ? [agentId] : [];
}

export function coerceTextFromToolResultResult(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const content = (result as any).content as unknown;
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const chunks: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if ((item as any).type !== 'text') continue;
    const text = (item as any).text;
    if (typeof text === 'string' && text.trim().length > 0) chunks.push(text.trim());
  }
  const joined = chunks.join('\n').trim();
  return joined.length > 0 ? joined : null;
}

export function findClaudeSubagentJsonlPath(params: { sessionId: string; agentId: string }): string | null {
  const base = join(homedir(), '.claude', 'projects');
  if (!existsSync(base)) return null;

  const projectDirs = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(base, d.name));

  const readFirstLineUtf8 = (filePath: string): string | null => {
    let fd: number | null = null;
    try {
      fd = openSync(filePath, 'r');
      const buf = Buffer.alloc(4096);
      const bytes = readSync(fd, buf, 0, buf.length, 0);
      if (bytes <= 0) return null;
      const text = buf.toString('utf8', 0, bytes);
      const idx = text.indexOf('\n');
      const firstLine = (idx >= 0 ? text.slice(0, idx) : text).trim();
      return firstLine.length > 0 ? firstLine : null;
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  };

  const coerceStringContentFromJsonlRecord = (value: unknown): string | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const message = (value as any).message;
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      if ((item as any).type !== 'text') continue;
      const text = (item as any).text;
      if (typeof text === 'string' && text.trim().length > 0) parts.push(text);
    }
    const joined = parts.join('\n').trim();
    return joined.length > 0 ? joined : null;
  };

  const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const projectDir of projectDirs) {
    const candidate = join(projectDir, params.sessionId, 'subagents', 'agent-' + params.agentId + '.jsonl');
    if (existsSync(candidate)) return candidate;

    // Agent Teams: tool_use_result.agent_id often looks like "Alpha@team" but JSONL files may be written with a hashed id.
    const atIndex = String(params.agentId).indexOf('@');
    if (atIndex <= 0) continue;
    const nameGuess = String(params.agentId).slice(0, atIndex).trim();
    if (!nameGuess) continue;
    const subagentsDir = join(projectDir, params.sessionId, 'subagents');
    let entries: string[] = [];
    try {
      entries = readdirSync(subagentsDir);
    } catch {
      continue;
    }
    const youAreRe = new RegExp(`\\bYou\\s+are\\s+${escapeRegExp(nameGuess)}\\b`, 'i');
    const summaryRe = new RegExp(`summary\\s*=\\s*\"\\s*${escapeRegExp(nameGuess)}`, 'i');
    const summaryContainsNameRe = new RegExp(
      `summary\\s*=\\s*["'][^"']*\\b${escapeRegExp(nameGuess)}\\b[^"']*["']`,
      'i',
    );
    for (const fileName of entries) {
      if (!fileName.startsWith('agent-') || !fileName.endsWith('.jsonl')) continue;
      const filePath = join(subagentsDir, fileName);
      const firstLine = readFirstLineUtf8(filePath);
      if (!firstLine) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(firstLine);
      } catch {
        continue;
      }
      const content = coerceStringContentFromJsonlRecord(parsed);
      if (!content) continue;
      if (youAreRe.test(content) || summaryRe.test(content) || summaryContainsNameRe.test(content)) return filePath;
    }
  }
  return null;
}

export async function runRealClaudeCliStreamJsonProbe(params: {
  prompt: string;
  timeoutMs: number;
  maxTurns: number;
  envOverlay?: Record<string, string>;
  stopWhen?: (acc: Pick<RealClaudeStreamJsonProbeResult, 'toolUses' | 'toolResults' | 'toolUseNames' | 'initTools'>) => boolean;
}): Promise<RealClaudeStreamJsonProbeResult> {
  const cwd = mkdtempSync(join(tmpdir(), 'happier-real-claude-probe-'));
  const stdoutTail: string[] = [];
  const stderrTail: string[] = [];
  const toolUseNames: string[] = [];
  const toolUses: RealClaudeToolUseBlock[] = [];
  const toolResults: RealClaudeToolResultBlock[] = [];
  const agentIds: string[] = [];
  let initTools: string[] = [];
  let sessionId: string | null = null;

  const keepTail = (buffer: string[], line: string) => {
    buffer.push(line);
    if (buffer.length > 50) buffer.splice(0, buffer.length - 50);
  };

  const child = spawn(
    'claude',
    [
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'default',
      '--max-turns',
      String(params.maxTurns),
      '--print',
      params.prompt,
    ],
    {
      cwd,
      env: {
        ...process.env,
        ...(params.envOverlay ?? {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  let killOnTimeout: NodeJS.Timeout | null = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, params.timeoutMs);
  let stopRequested = false;
  let killAfterStop: NodeJS.Timeout | null = null;

  const requestStop = () => {
    if (stopRequested) return;
    stopRequested = true;
    if (killOnTimeout) clearTimeout(killOnTimeout);
    killOnTimeout = null;
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    killAfterStop = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 5_000);
  };

  const rlOut = createInterface({ input: child.stdout });
  rlOut.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    keepTail(stdoutTail, trimmed);
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      sessionId = sessionId ?? extractSessionIdFromStreamJsonLine(parsed);
      if (initTools.length === 0) {
        const maybeInitTools = extractInitToolsFromStreamJsonLine(parsed);
        if (maybeInitTools.length > 0) initTools = maybeInitTools;
      }
      for (const name of extractToolUseNamesFromStreamJsonLine(parsed)) toolUseNames.push(name);
      for (const use of extractToolUseBlocksFromStreamJsonLine(parsed)) toolUses.push(use);
      for (const res of extractToolResultBlocksFromStreamJsonLine(parsed)) toolResults.push(res);
      for (const agentId of extractAgentIdsFromStreamJsonLine(parsed)) agentIds.push(agentId);

      if (params.stopWhen && !stopRequested) {
        if (params.stopWhen({ toolUses, toolResults, toolUseNames, initTools })) requestStop();
      }
    } catch {
      // ignore parse errors; keep tail for diagnostics
    }
  });

  const rlErr = createInterface({ input: child.stderr });
  rlErr.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    keepTail(stderrTail, trimmed);
  });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  if (killOnTimeout) clearTimeout(killOnTimeout);
  if (killAfterStop) clearTimeout(killAfterStop);
  rlOut.close();
  rlErr.close();

  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    // ignore
  }

  return {
    sessionId,
    agentIds,
    initTools,
    toolUseNames,
    toolUses,
    toolResults,
    stdoutTail,
    stderrTail,
    exitCode: exit.code,
    signal: exit.signal,
  };
}
