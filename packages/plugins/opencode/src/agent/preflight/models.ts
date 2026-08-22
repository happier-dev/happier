import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';

import { buildOpenCodeThinkingModelOptionsFromVariants } from '../config/thinking.js';
import { asRecord, normalizeString } from '../runtime/server/openCodeParsing.js';
import { OPEN_CODE_SYSTEM_TOOL_ID } from '../systemTool.js';

export type OpenCodePreflightModel = Readonly<{
  id: string;
  name: string;
  description?: string;
  modelOptions?: ReturnType<typeof buildOpenCodeThinkingModelOptionsFromVariants>;
}>;

type KnownUnavailableOpenCodeModel = Readonly<{
  retiredAtMs: number;
  replacementModelId: string;
}>;

const OPENCODE_CLI_MODELS_COMMAND_ARGS = ['models'] as const;
const OPENCODE_VERBOSE_MODELS_COMMAND_ARGS = ['models', '--verbose'] as const;
const MIN_PREFLIGHT_MODELS_TIMEOUT_MS = 120_000;

function buildOpenCodePreflightEnv(env: NodeJS.ProcessEnv | undefined): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string') output[key] = value;
  }
  output.CI = '1';
  return output;
}

/**
 * OpenCode's own replacement pin for Anthropic's retired flagship models.
 *
 * Every other replacement in the table below is pinned the same way: the table
 * is OpenCode's product data about a third party's lineup, not a Happier-wide
 * model policy. Reading it from a host workspace package instead made this
 * plugin unbuildable for an external author writing the same plugin: the
 * plugin scaffold binds an author to the public toolchain packages
 * (`@happier-dev/plugin-sdk`, plus `@happier-dev/plugin-ui` for a UI plugin)
 * and to no host workspace package.
 */
const ANTHROPIC_FLAGSHIP_REPLACEMENT_MODEL_ID = 'claude-opus-5';

const ANTHROPIC_KNOWN_UNAVAILABLE_MODELS: Readonly<Record<string, KnownUnavailableOpenCodeModel>> = Object.freeze({
  'claude-2.0': { retiredAtMs: Date.UTC(2025, 6, 21), replacementModelId: ANTHROPIC_FLAGSHIP_REPLACEMENT_MODEL_ID },
  'claude-2.1': { retiredAtMs: Date.UTC(2025, 6, 21), replacementModelId: ANTHROPIC_FLAGSHIP_REPLACEMENT_MODEL_ID },
  'claude-instant-1.0': { retiredAtMs: Date.UTC(2024, 10, 6), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-instant-1.1': { retiredAtMs: Date.UTC(2024, 10, 6), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-instant-1.2': { retiredAtMs: Date.UTC(2024, 10, 6), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-3-opus-20240229': { retiredAtMs: Date.UTC(2026, 0, 5), replacementModelId: ANTHROPIC_FLAGSHIP_REPLACEMENT_MODEL_ID },
  'claude-3-opus-latest': { retiredAtMs: Date.UTC(2026, 0, 5), replacementModelId: ANTHROPIC_FLAGSHIP_REPLACEMENT_MODEL_ID },
  'claude-3-sonnet-20240229': { retiredAtMs: Date.UTC(2025, 6, 21), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-sonnet-latest': { retiredAtMs: Date.UTC(2025, 6, 21), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-haiku-20240307': { retiredAtMs: Date.UTC(2026, 3, 20), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-3-haiku-latest': { retiredAtMs: Date.UTC(2026, 3, 20), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-3-5-sonnet-20240620': { retiredAtMs: Date.UTC(2025, 9, 28), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-5-sonnet-20241022': { retiredAtMs: Date.UTC(2025, 9, 28), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-5-sonnet-latest': { retiredAtMs: Date.UTC(2025, 9, 28), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-5-haiku-20241022': { retiredAtMs: Date.UTC(2026, 1, 19), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-3-5-haiku-latest': { retiredAtMs: Date.UTC(2026, 1, 19), replacementModelId: 'claude-haiku-4-5-20251001' },
  'claude-3-7-sonnet-20250219': { retiredAtMs: Date.UTC(2026, 1, 19), replacementModelId: 'claude-sonnet-4-6' },
  'claude-3-7-sonnet-latest': { retiredAtMs: Date.UTC(2026, 1, 19), replacementModelId: 'claude-sonnet-4-6' },
  'claude-sonnet-4-20250514': { retiredAtMs: Date.UTC(2026, 5, 15), replacementModelId: 'claude-sonnet-4-6' },
  'claude-opus-4-20250514': { retiredAtMs: Date.UTC(2026, 5, 15), replacementModelId: ANTHROPIC_FLAGSHIP_REPLACEMENT_MODEL_ID },
});

const KNOWN_UNAVAILABLE_MODELS_BY_PROVIDER = Object.freeze({
  anthropic: ANTHROPIC_KNOWN_UNAVAILABLE_MODELS,
} as const);

function isVerboseModelIdLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && /^[a-z0-9._:-]+\/[a-z0-9._:-]+$/iu.test(trimmed);
}

function extractJsonBlock(lines: readonly string[], startIndex: number): Readonly<{
  jsonText: string;
  endIndexInclusive: number;
}> | null {
  let depth = 0;
  let started = false;
  let jsonText = '';

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
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
      return { jsonText, endIndexInclusive: index };
    }
  }
  return null;
}

function parseJsonObject(text: string): Readonly<Record<string, unknown>> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function parseVerboseBlocks(outputRaw: string): readonly Readonly<{
  fullId: string;
  record: Readonly<Record<string, unknown>>;
}>[] {
  const lines = outputRaw.split('\n');
  const parsed: Array<Readonly<{ fullId: string; record: Readonly<Record<string, unknown>> }>> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] ?? '').trim();
    if (!isVerboseModelIdLine(line)) continue;

    let cursor = index + 1;
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

    const block = extractJsonBlock(lines, cursor);
    if (!block) continue;
    const record = parseJsonObject(block.jsonText);
    if (record) parsed.push({ fullId: line, record });
    index = block.endIndexInclusive;
  }

  return parsed;
}

function isKnownUnavailableOpenCodeModel(params: Readonly<{
  providerId: string;
  modelId: string;
  nowMs: number;
}>): boolean {
  const providerModels = KNOWN_UNAVAILABLE_MODELS_BY_PROVIDER[
    normalizeString(params.providerId).toLowerCase() as keyof typeof KNOWN_UNAVAILABLE_MODELS_BY_PROVIDER
  ];
  const entry = providerModels?.[normalizeString(params.modelId).toLowerCase()];
  return Boolean(entry && params.nowMs >= entry.retiredAtMs);
}

function modelSupportsToolCalls(
  raw: unknown,
  providerIdHint: string,
  nowMs: number,
): boolean {
  const record = asRecord(raw);
  if (!record) return false;
  const providerId = normalizeString(providerIdHint) || normalizeString(record.providerID);
  const modelId = normalizeString(record.id);
  if (providerId && modelId && isKnownUnavailableOpenCodeModel({ providerId, modelId, nowMs })) {
    return false;
  }
  const status = normalizeString(record.status);
  if (status && status !== 'active') return false;
  const capabilities = asRecord(record.capabilities);
  if (!capabilities || capabilities.toolcall !== true) return false;
  const input = asRecord(capabilities.input);
  return input?.text !== false;
}

export function buildOpenCodePreflightModelsFromVerboseOutput(
  outputRaw: string,
  options: Readonly<{ nowMs?: number }> = {},
): readonly OpenCodePreflightModel[] | null {
  const nowMs = typeof options.nowMs === 'number' && Number.isFinite(options.nowMs)
    ? options.nowMs
    : Date.now();
  const models = parseVerboseBlocks(outputRaw)
    .map((block): OpenCodePreflightModel | null => {
      const providerId = block.fullId.slice(0, block.fullId.indexOf('/'));
      if (!modelSupportsToolCalls(block.record, providerId, nowMs)) return null;
      const name = normalizeString(block.record.name) || block.fullId;
      const description = normalizeString(block.record.family) || normalizeString(block.record.providerID);
      const capabilities = asRecord(block.record.capabilities);
      const modelOptions = capabilities?.reasoning === true
        ? buildOpenCodeThinkingModelOptionsFromVariants(block.record.variants, null)
        : null;
      return {
        id: block.fullId,
        name,
        ...(description ? { description } : {}),
        ...(modelOptions ? { modelOptions } : {}),
      };
    })
    .filter((model): model is OpenCodePreflightModel => model !== null);

  return models.length > 0 ? models : null;
}

function buildOpenCodePreflightModelsFromPlainOutput(outputRaw: string): readonly OpenCodePreflightModel[] | null {
  const nowMs = Date.now();
  const seen = new Set<string>();
  const models: OpenCodePreflightModel[] = [];

  for (const rawLine of outputRaw.split('\n')) {
    const id = rawLine.trim();
    if (!isVerboseModelIdLine(id) || seen.has(id)) continue;
    const separatorIndex = id.indexOf('/');
    if (isKnownUnavailableOpenCodeModel({
      providerId: id.slice(0, separatorIndex),
      modelId: id.slice(separatorIndex + 1),
      nowMs,
    })) {
      continue;
    }
    seen.add(id);
    models.push({ id, name: id });
  }

  return models.length > 0 ? models : null;
}

export async function probeOpenCodePreflightModelsRaw(params: Readonly<{
  exec: ExecService;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}>): Promise<readonly OpenCodePreflightModel[] | null> {
  const env = buildOpenCodePreflightEnv(params.env);
  const timeoutMs = Math.max(MIN_PREFLIGHT_MODELS_TIMEOUT_MS, params.timeoutMs);
  const resolved = await params.exec.systemTools.resolve({
    toolId: OPEN_CODE_SYSTEM_TOOL_ID,
    purpose: 'Probe OpenCode models',
    cwd: params.cwd,
  });
  const decodeStdout = (result: PluginProcessResult): string => new TextDecoder().decode(result.stdout);
  const succeeded = (result: PluginProcessResult): boolean => (
    result.termination.observed.kind === 'exit'
    && result.termination.observed.exitCode === 0
  );
  const verboseResult = await params.exec.run({
    executable: resolved.executable,
    args: OPENCODE_VERBOSE_MODELS_COMMAND_ARGS,
    cwd: { root: 'workspace', relativePath: '' },
    env,
    timeoutMs,
  });

  if (succeeded(verboseResult)) {
    const verboseModels = buildOpenCodePreflightModelsFromVerboseOutput(decodeStdout(verboseResult));
    if (verboseModels) return verboseModels;
  }

  const plainResult = await params.exec.run({
    executable: resolved.executable,
    args: OPENCODE_CLI_MODELS_COMMAND_ARGS,
    cwd: { root: 'workspace', relativePath: '' },
    env,
    timeoutMs,
  });

  if (!succeeded(plainResult)) return null;
  return buildOpenCodePreflightModelsFromPlainOutput(decodeStdout(plainResult));
}

export const OPENCODE_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  connectedServiceAuth: 'materialized-env',
  failureCacheStrategy: 'cooldown',
  probeModelsRaw: probeOpenCodePreflightModelsRaw,
  cliModelsCommandArgs: OPENCODE_CLI_MODELS_COMMAND_ARGS,
  verboseModelsCommandArgs: OPENCODE_VERBOSE_MODELS_COMMAND_ARGS,
} as const);
