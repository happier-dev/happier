import { appendFile, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

import { SDKToLogConverter } from './sdkToLogConverter';
import { getProjectPath } from './path';
import { resolveClaudeConfigDirOverride } from './resolveClaudeConfigDirOverride';

type ToolUseParentMap = Map<string, string | null>;

function resolveTildePath(inputPath: string): string {
  const trimmed = String(inputPath ?? '').trim();
  if (!trimmed) return inputPath;
  const home = homedir();
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/')) return join(home, trimmed.slice(2));
  return inputPath;
}

function parseToolBlocksFromJsonLine(value: unknown): {
  toolUseIds: Set<string>;
  toolResultIds: Set<string>;
  toolUseParentToolUseId: ToolUseParentMap;
} {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  const toolUseParentToolUseId: ToolUseParentMap = new Map();

  const entry: any = value;
  const parentToolUseId =
    typeof entry?.parent_tool_use_id === 'string'
      ? entry.parent_tool_use_id
      : typeof entry?.parentToolUseId === 'string'
        ? entry.parentToolUseId
        : typeof entry?.sidechainId === 'string'
          ? entry.sidechainId
          : null;

  const blocks = entry?.message?.content;
  if (!Array.isArray(blocks)) {
    return { toolUseIds, toolResultIds, toolUseParentToolUseId };
  }

  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    if ((block as any).type === 'tool_use' && typeof (block as any).id === 'string') {
      const id = String((block as any).id);
      toolUseIds.add(id);
      if (parentToolUseId && !toolUseParentToolUseId.has(id)) {
        toolUseParentToolUseId.set(id, parentToolUseId);
      }
      continue;
    }
    if ((block as any).type === 'tool_result' && typeof (block as any).tool_use_id === 'string') {
      toolResultIds.add(String((block as any).tool_use_id));
    }
  }

  return { toolUseIds, toolResultIds, toolUseParentToolUseId };
}

async function readTailUtf8(path: string, maxBytes: number): Promise<{ text: string; truncatedPrefix: boolean }> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    const size = Number.isFinite(stat.size) ? Math.max(0, Math.trunc(stat.size)) : 0;
    const boundedMaxBytes = Number.isFinite(maxBytes) ? Math.max(1, Math.trunc(maxBytes)) : 1;
    const start = Math.max(0, size - boundedMaxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    return { text: buf.toString('utf8'), truncatedPrefix: start > 0 };
  } finally {
    await handle.close();
  }
}

async function repairJsonlTail(params: Readonly<{ transcriptPath: string }>): Promise<void> {
  const maxBytes = configuration.filesReadMaxBytes;
  const effectiveMaxBytes = Number.isFinite(maxBytes) ? Math.max(1, Math.trunc(maxBytes)) : 1;

  const handle = await open(params.transcriptPath, 'r+');
  try {
    const stat = await handle.stat();
    const size = Number.isFinite(stat.size) ? Math.max(0, Math.trunc(stat.size)) : 0;
    if (size === 0) return;

    const readSize = Math.min(size, effectiveMaxBytes);
    const start = Math.max(0, size - readSize);
    const length = size - start;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);

    // If the file already ends in a newline, we treat it as a complete JSONL record boundary.
    if (buf.length > 0 && buf[buf.length - 1] === 0x0a) {
      return;
    }

    const lastNewlineIndex = buf.lastIndexOf(0x0a);
    if (lastNewlineIndex === -1) {
      // Avoid destructive truncation when we cannot safely identify a record boundary.
      return;
    }

    const tailLine = buf.slice(lastNewlineIndex + 1).toString('utf8').trim();
    if (tailLine.length === 0) {
      // There is trailing whitespace after the last newline but no newline terminator.
      await appendFile(params.transcriptPath, '\n');
      return;
    }

    try {
      JSON.parse(tailLine);
      // Complete last line but missing newline terminator.
      await appendFile(params.transcriptPath, '\n');
      return;
    } catch {
      // Incomplete/invalid last line: truncate back to the previous record boundary.
      const truncateTo = start + lastNewlineIndex + 1;
      if (truncateTo >= 0 && truncateTo < size) {
        await handle.truncate(truncateTo);
      }
    }
  } catch {
    // Best-effort: transcript tail repair should never crash callers.
  } finally {
    await handle.close();
  }
}

async function waitForToolUseIdsToAppear(params: Readonly<{ transcriptPath: string; toolUseIds: ReadonlySet<string> | null }>): Promise<void> {
  const timeoutMs = configuration.claudeTranscriptRepairWaitForToolUseIdsTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;

  const pollIntervalMs = configuration.claudeTranscriptRepairWaitForToolUseIdsPollIntervalMs;
  const effectivePollIntervalMs = Number.isFinite(pollIntervalMs) && pollIntervalMs >= 10 ? pollIntervalMs : 25;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { text } = await readTailUtf8(params.transcriptPath, configuration.filesReadMaxBytes);
      if (params.toolUseIds) {
        let missing = 0;
        for (const toolUseId of params.toolUseIds) {
          if (!text.includes(toolUseId)) missing += 1;
        }
        if (missing === 0) return;
      } else {
        // When we don't know which tool_use ids to expect (e.g. interrupt happened before the
        // tool_use record flushed to disk), wait briefly for *any* tool_use block so we can compute
        // missing tool_result ids reliably.
        if (text.includes('\"type\":\"tool_use\"')) return;
      }
    } catch {
      // If the transcript doesn't exist yet (or is mid-write), keep waiting until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, effectivePollIntervalMs));
  }
}

export async function repairClaudeSessionJsonlToolResults(params: {
  transcriptPath: string | null;
  cwd: string;
  sessionId: string | null;
  onlyToolUseIds?: Iterable<string> | null;
}): Promise<{ appendedToolUseIds: string[] }> {
  const sessionId = typeof params.sessionId === 'string' && params.sessionId.trim().length > 0 ? params.sessionId.trim() : null;
  if (!sessionId) return { appendedToolUseIds: [] };

  const resolvedCwd = resolveTildePath(params.cwd);

  const transcriptPath = (() => {
    const provided = typeof params.transcriptPath === 'string' ? params.transcriptPath.trim() : '';
    if (provided) return provided;
    const claudeConfigDirOverride = resolveClaudeConfigDirOverride(process.env);
    return join(getProjectPath(resolvedCwd, claudeConfigDirOverride), `${sessionId}.jsonl`);
  })();

  const onlyToolUseIdsSet = (() => {
    if (!params.onlyToolUseIds) return null;
    const set = new Set<string>();
    for (const id of params.onlyToolUseIds) {
      if (typeof id === 'string' && id.trim().length > 0) {
        set.add(id.trim());
      }
    }
    return set.size > 0 ? set : null;
  })();

  try {
    await repairJsonlTail({ transcriptPath });
    await waitForToolUseIdsToAppear({ transcriptPath, toolUseIds: onlyToolUseIdsSet });

    const { text, truncatedPrefix } = await readTailUtf8(transcriptPath, configuration.filesReadMaxBytes);
    const rawLines = text.split('\n');
    const lines = truncatedPrefix ? rawLines.slice(1) : rawLines;

    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    const parentToolUseIdByToolUseId: ToolUseParentMap = new Map();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const parsed = parseToolBlocksFromJsonLine(value);
      for (const id of parsed.toolUseIds) toolUseIds.add(id);
      for (const id of parsed.toolResultIds) toolResultIds.add(id);
      for (const [id, parentToolUseId] of parsed.toolUseParentToolUseId.entries()) {
        if (!parentToolUseIdByToolUseId.has(id)) {
          parentToolUseIdByToolUseId.set(id, parentToolUseId);
        }
      }
    }

    const missingToolUseIds: string[] = [];
    for (const id of toolUseIds) {
      if (onlyToolUseIdsSet && !onlyToolUseIdsSet.has(id)) continue;
      if (!toolResultIds.has(id)) {
        missingToolUseIds.push(id);
      }
    }

    if (missingToolUseIds.length === 0) return { appendedToolUseIds: [] };

    const converter = new SDKToLogConverter({ sessionId, cwd: resolvedCwd });
    const payload = missingToolUseIds
      .map((toolUseId) =>
        JSON.stringify(converter.generateInterruptedToolResult(toolUseId, parentToolUseIdByToolUseId.get(toolUseId) ?? null)),
      )
      .join('\n')
      .concat('\n');

    await appendFile(transcriptPath, payload);
    logger.debug('[claude] repaired transcript tool_results', {
      transcriptPath,
      appendedToolUseIds: missingToolUseIds,
    });

    return { appendedToolUseIds: missingToolUseIds };
  } catch (error) {
    logger.debug('[claude] transcript tool_result repair failed (non-fatal)', { transcriptPath, error });
    return { appendedToolUseIds: [] };
  }
}
