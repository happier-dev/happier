import type { PreflightModelsProbeAdapter } from '@/capabilities/probes/preflightModelsProbeAdapterTypes';
import { resolveCliPathOverride } from '@/agent/acp/resolveCliPathOverride';
import { killProcessTree } from '@/agent/acp/killProcessTree';
import { resolveProviderCliCommand } from '@/runtime/managedTools/providerCliResolution';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { spawn } from 'node:child_process';

import { asRecord, normalizeString } from '../server/openCodeParsing';
import { modelSupportsToolCalls } from '../server/openCodeModelParsing';
import { buildOpenCodeThinkingModelOptionsFromVariants } from '../modelOptions/openCodeThinkingModelOption';

type OpenCodeVerboseModelRecord = Readonly<{
  id?: string;
  providerID?: string;
  name?: string;
  family?: string;
  status?: string;
  capabilities?: unknown;
  variants?: unknown;
}>;

type OpenCodeVerboseModelBlock = Readonly<{
  fullId: string;
  record: OpenCodeVerboseModelRecord;
}>;

function isOpenCodeVerboseModelIdLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // Example: openai/codex-mini-latest, openrouter/gemini-2.5-flash-preview:thinking
  return /^[a-z0-9._:-]+\/[a-z0-9._:-]+$/i.test(trimmed);
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractJsonBlockFromLines(lines: string[], startIndex: number): { jsonText: string; endIndexInclusive: number } | null {
  let depth = 0;
  let started = false;
  let jsonText = '';

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i] ?? '';
    jsonText += `${line}\n`;
    for (const ch of line) {
      if (ch === '{') {
        depth += 1;
        started = true;
      } else if (ch === '}') {
        depth -= 1;
      }
    }
    if (started && depth === 0) {
      return { jsonText, endIndexInclusive: i };
    }
  }

  return null;
}

function parseOpenCodeModelsVerboseOutput(outputRaw: string): OpenCodeVerboseModelBlock[] | null {
  const output = typeof outputRaw === 'string' ? outputRaw : '';
  if (!output.trim()) return null;

  const lines = output.split('\n');
  const parsed: OpenCodeVerboseModelBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] ?? '').trim();
    if (!isOpenCodeVerboseModelIdLine(line)) continue;

    const fullId = line;
    let cursor = i + 1;
    while (cursor < lines.length) {
      const next = String(lines[cursor] ?? '').trim();
      if (next === '') {
        cursor += 1;
        continue;
      }
      if (next.startsWith('{')) break;
      cursor += 1;
    }
    if (cursor >= lines.length) continue;

    const block = extractJsonBlockFromLines(lines, cursor);
    if (!block) continue;

    const record = tryParseJsonObject(block.jsonText);
    if (!record) {
      i = block.endIndexInclusive;
      continue;
    }

    parsed.push({ fullId, record });
    i = block.endIndexInclusive;
  }

  return parsed.length > 0 ? parsed : null;
}

async function probeOpenCodeModelsVerbose(params: Readonly<{ cwd: string; timeoutMs: number }>): Promise<unknown[] | null> {
  const timeoutMs = Math.max(250, params.timeoutMs);
  const command =
    resolveCliPathOverride({ agentId: 'opencode' })
    ?? resolveProviderCliCommand('opencode')?.command
    ?? 'opencode';
  const args = ['models', '--verbose'];

  return await new Promise((resolve) => {
    let stdout = '';
    let settled = false;

    const finish = (result: unknown[] | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const invocation = resolveWindowsCommandInvocation({
      command,
      args,
      resolveCommandOnPath: true,
    });

    const child = spawn(invocation.command, invocation.args, {
      cwd: params.cwd,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    const timer = setTimeout(() => {
      if (process.platform === 'win32') {
        void killProcessTree(child, { graceMs: 250 }).catch(() => undefined);
      } else {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
      finish(null);
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      if (typeof code !== 'number' || code !== 0) return finish(null);

      const blocks = parseOpenCodeModelsVerboseOutput(stdout);
      if (!blocks) return finish(null);

      const models = blocks
        .map((block) => {
          const record = block.record;
          if (!modelSupportsToolCalls(record)) return null;
          const fullId = block.fullId;
          const name = normalizeString(record.name) || fullId;
          const description = normalizeString(record.family) || normalizeString(record.providerID) || undefined;
          const capabilities = asRecord(record.capabilities);
          const supportsReasoning = capabilities ? capabilities.reasoning === true : false;
          const modelOptions = supportsReasoning
            ? buildOpenCodeThinkingModelOptionsFromVariants(record.variants, null)
            : null;
          return {
            id: fullId,
            name,
            ...(description ? { description } : {}),
            ...(modelOptions ? { modelOptions } : {}),
          };
        })
        .filter((m): m is NonNullable<typeof m> => m !== null);

      finish(models.length > 0 ? models : null);
    });
  });
}

export const openCodePreflightModelsProbeAdapter: PreflightModelsProbeAdapter = {
  failureCacheStrategy: 'cooldown',
  probeModelsRaw: async ({ cwd, timeoutMs }) => {
    return await probeOpenCodeModelsVerbose({ cwd, timeoutMs });
  },
};
