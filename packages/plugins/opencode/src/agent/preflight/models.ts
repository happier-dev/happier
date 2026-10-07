import type {
  AgentPreflightSessionControlsCommandResultV1,
  AgentPreflightSessionControlsContributionV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { probeOpenCodePreflightCatalogs, resolveOpenCodePreflightProbeVariant } from './catalogs.js';
import { OPENCODE_CHILD_LAUNCH_ENV_KEYS } from '../runtime/server/spawnSpec.js';
import { isOpenCodeModelSelectable } from '../models/eligibility.js';
import { buildOpenCodeThinkingModelOptionsFromVariants } from '../config/thinking.js';
import { asRecord, normalizeString } from '../runtime/server/openCodeParsing.js';
import {
  OPEN_CODE_STABLE_SYSTEM_TOOL_ID,
  OPEN_CODE_SYSTEM_TOOL_ID,
  OPEN_CODE_V2_SYSTEM_TOOL_ID,
  resolveOpenCodeSystemToolId,
} from '../systemTool.js';

export type OpenCodePreflightModel = Readonly<{
  id: string;
  name: string;
  description?: string;
  contextWindowTokens?: number;
  modelOptions?: NonNullable<ReturnType<typeof buildOpenCodeThinkingModelOptionsFromVariants>>;
}>;

const OPENCODE_V2_MODELS_COMMAND_ARGS = [
  'api',
  'get',
  '/api/model',
  '--standalone',
  '--param',
  'location[directory]=.',
] as const;
const OPENCODE_VERBOSE_MODELS_COMMAND_ARGS = ['models', '--verbose'] as const;
function parseOpenCodeModelId(line: string): Readonly<{ providerId: string; modelId: string }> | null {
  const trimmed = line.trim();
  const separatorIndex = trimmed.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) return null;
  return {
    providerId: trimmed.slice(0, separatorIndex),
    modelId: trimmed.slice(separatorIndex + 1),
  };
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
}>[] | null {
  const lines = outputRaw.split('\n');
  const parsed: Array<Readonly<{ fullId: string; record: Readonly<Record<string, unknown>> }>> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] ?? '').trim();
    const parsedId = parseOpenCodeModelId(line);
    if (!parsedId) continue;

    let cursor = index + 1;
    while (cursor < lines.length) {
      const next = String(lines[cursor] ?? '').trim();
      if (next === '') {
        cursor += 1;
        continue;
      }
      break;
    }
    if (cursor >= lines.length || !String(lines[cursor] ?? '').trim().startsWith('{')) continue;

    const block = extractJsonBlock(lines, cursor);
    if (!block) return null;
    const record = parseJsonObject(block.jsonText);
    if (!record) return null;
    if (
      parsedId.providerId !== normalizeString(record.providerID)
      || parsedId.modelId !== normalizeString(record.id)
    ) return null;
    parsed.push({ fullId: line, record });
    index = block.endIndexInclusive;
  }

  return parsed.length > 0 || !outputRaw.trim() ? parsed : null;
}

function modelSupportsReasoningVariants(record: Readonly<Record<string, unknown>>): boolean {
  const variants = record.variants;
  if (Array.isArray(variants)) return variants.length > 0;
  return asRecord(record.capabilities)?.reasoning === true;
}

function readContextWindowTokens(record: Readonly<Record<string, unknown>>): number | undefined {
  const value = asRecord(record.limit)?.context;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function buildOpenCodePreflightModels(
  blocks: readonly Readonly<{ fullId: string; record: Readonly<Record<string, unknown>> }>[],
  nowMs: number,
): readonly OpenCodePreflightModel[] | null {
  const models = blocks
    .map((block): OpenCodePreflightModel | null => {
      const providerId = block.fullId.slice(0, block.fullId.indexOf('/'));
      if (!isOpenCodeModelSelectable({ providerID: providerId, modelID: block.fullId.slice(providerId.length + 1), modelRecord: block.record, nowMs })) return null;
      const name = normalizeString(block.record.name) || block.fullId;
      const description = normalizeString(block.record.family) || normalizeString(block.record.providerID);
      const contextWindowTokens = readContextWindowTokens(block.record);
      const modelOptions = modelSupportsReasoningVariants(block.record)
        ? buildOpenCodeThinkingModelOptionsFromVariants(block.record.variants, null)
        : null;
      return {
        id: block.fullId,
        name,
        ...(description ? { description } : {}),
        ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
        ...(modelOptions ? { modelOptions } : {}),
      };
    })
    .filter((model): model is OpenCodePreflightModel => model !== null);

  return models;
}

export function buildOpenCodePreflightModelsFromV2ApiOutput(
  outputRaw: string,
  options: Readonly<{ nowMs?: number }> = {},
): readonly OpenCodePreflightModel[] | null {
  const envelope = parseJsonObject(outputRaw);
  if (!Array.isArray(envelope?.data)) return null;
  const blocks = envelope.data.flatMap((rawModel) => {
    const record = asRecord(rawModel);
    const providerId = normalizeString(record?.providerID);
    const modelId = normalizeString(record?.id);
    return record && providerId && modelId
      ? [{ fullId: `${providerId}/${modelId}`, record }]
      : [];
  });
  if (envelope.data.length > 0 && blocks.length === 0) return null;
  const nowMs = typeof options.nowMs === 'number' && Number.isFinite(options.nowMs)
    ? options.nowMs
    : Date.now();
  return buildOpenCodePreflightModels(blocks, nowMs);
}

export function buildOpenCodePreflightModelsFromVerboseOutput(
  outputRaw: string,
  options: Readonly<{ nowMs?: number }> = {},
): readonly OpenCodePreflightModel[] | null {
  const nowMs = typeof options.nowMs === 'number' && Number.isFinite(options.nowMs)
    ? options.nowMs
    : Date.now();
  const blocks = parseVerboseBlocks(outputRaw);
  if (!blocks) return null;
  return buildOpenCodePreflightModels(blocks, nowMs);
}

export const OPENCODE_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  resolveProbeVariant: resolveOpenCodePreflightProbeVariant,
  probeCatalogs: probeOpenCodePreflightCatalogs,
  managedServiceCommands: Object.freeze([OPEN_CODE_SYSTEM_TOOL_ID, OPEN_CODE_STABLE_SYSTEM_TOOL_ID, OPEN_CODE_V2_SYSTEM_TOOL_ID].map((toolId) => Object.freeze({
    toolId, args: Object.freeze(['serve', '--hostname', '127.0.0.1']),
    environmentKeys: Object.freeze([...OPENCODE_CHILD_LAUNCH_ENV_KEYS, 'OPENCODE_PERMISSION', 'OPENCODE_DISABLE_PRUNE', 'OPENCODE_SERVER_PASSWORD']), ci: 'omit' as const,
  }))),
  jsonRpcCommands: Object.freeze([OPEN_CODE_SYSTEM_TOOL_ID, OPEN_CODE_STABLE_SYSTEM_TOOL_ID, OPEN_CODE_V2_SYSTEM_TOOL_ID].flatMap((toolId) => [
    Object.freeze({ toolId, args: Object.freeze(['--version']) }),
    Object.freeze({ toolId, args: Object.freeze(['acp']) }),
  ])),
  models: Object.freeze({
    commandToolIds: Object.freeze([
      OPEN_CODE_SYSTEM_TOOL_ID,
      OPEN_CODE_STABLE_SYSTEM_TOOL_ID,
      OPEN_CODE_V2_SYSTEM_TOOL_ID,
    ]),
    resolveCommandToolId: ({ accountSettings }: Readonly<{
      accountSettings: Readonly<Record<string, unknown>> | null;
    }>) => resolveOpenCodeSystemToolId(
      accountSettings?.opencodeCliGeneration,
    ),
    command: Object.freeze({
      toolId: OPEN_CODE_SYSTEM_TOOL_ID,
      args: OPENCODE_V2_MODELS_COMMAND_ARGS,
    }),
    parseOutput: ({ stdout }: AgentPreflightSessionControlsCommandResultV1) =>
      buildOpenCodePreflightModelsFromV2ApiOutput(stdout),
    fallback: Object.freeze({
      command: Object.freeze({
        toolId: OPEN_CODE_SYSTEM_TOOL_ID,
        args: OPENCODE_VERBOSE_MODELS_COMMAND_ARGS,
      }),
      parseOutput: ({ stdout }: AgentPreflightSessionControlsCommandResultV1) =>
        buildOpenCodePreflightModelsFromVerboseOutput(stdout),
    }),
  }),
} satisfies AgentPreflightSessionControlsContributionV1);
