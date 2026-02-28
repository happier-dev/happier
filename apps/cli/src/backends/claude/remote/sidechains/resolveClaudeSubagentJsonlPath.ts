import { existsSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

function readFirstLineUtf8(filePath: string): string | null {
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
}

function coerceStringContentFromJsonlRecord(value: unknown): string | null {
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
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function resolveClaudeSubagentJsonlPath(params: Readonly<{
  projectDir: string;
  claudeSessionId: string;
  agentId: string;
}>): string | null {
  const sanitizedSessionId = String(params.claudeSessionId ?? '').trim();
  if (!sanitizedSessionId) return null;
  const sanitizedAgentId = String(params.agentId ?? '').trim();
  if (!sanitizedAgentId) return null;

  const subagentsDir = join(params.projectDir, sanitizedSessionId, 'subagents');
  const direct = join(subagentsDir, `agent-${sanitizedAgentId}.jsonl`);
  if (existsSync(direct)) return direct;

  // Agent Teams uses display-like agent ids (e.g. "Alpha@team") but writes JSONL files
  // with an internal hashed agent id. Fall back to scanning subagent file headers.
  const atIndex = sanitizedAgentId.indexOf('@');
  if (atIndex <= 0) return null;
  const nameGuess = sanitizedAgentId.slice(0, atIndex).trim();
  if (!nameGuess) return null;

  let entries: string[] = [];
  try {
    entries = readdirSync(subagentsDir);
  } catch {
    return null;
  }

  const youAreRe = new RegExp(`\\bYou\\s+are\\s+${escapeRegExp(nameGuess)}\\b`, 'i');
  const summaryRe = new RegExp(`summary\\s*=\\s*\"\\s*${escapeRegExp(nameGuess)}`, 'i');

  for (const fileName of entries) {
    if (!fileName.startsWith('agent-') || !fileName.endsWith('.jsonl')) continue;
    const candidate = join(subagentsDir, fileName);
    const firstLine = readFirstLineUtf8(candidate);
    if (!firstLine) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(firstLine);
    } catch {
      continue;
    }
    const content = coerceStringContentFromJsonlRecord(parsed);
    if (!content) continue;
    if (youAreRe.test(content) || summaryRe.test(content)) return candidate;
  }

  return null;
}
