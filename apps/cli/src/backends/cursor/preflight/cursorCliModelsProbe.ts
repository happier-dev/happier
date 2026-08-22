import { spawn } from 'node:child_process';

import type { ProbedAgentModel } from '@/capabilities/probes/agentModelsProbe';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import {
  formatModelOptionChoiceLabel,
  modelParamControlName,
  modelParamControlType,
  sortModelParamControlIds,
  sortModelParamValues,
} from '@/backends/cursor/acp/cursorModelConfigControls';
import {
  normalizeCursorModelVariantBaseId,
  normalizeToken,
  parseCursorCliTraits,
} from '@/backends/cursor/acp/cursorModelConfigParsing';

type ProbedAgentModelOption = NonNullable<ProbedAgentModel['modelOptions']>[number];
type ProbedAgentModelOptionValue = ProbedAgentModelOption['currentValue'];

type CursorCliModelLine = Readonly<{
  id: string;
  name: string;
}>;

type CursorCliModelVariant = CursorCliModelLine & Readonly<{
  baseId: string;
  fastMode?: boolean;
  thinking?: boolean;
  reasoning?: string;
  contextWindow?: string;
}>;

type CursorCliModelGroup = Readonly<{
  id: string;
  name: string;
  variants: ReadonlyArray<CursorCliModelVariant>;
}>;

const stdoutMaxBytes = 256 * 1024;

function parseCursorModelsLine(line: string): CursorCliModelLine | null {
  const trimmed = line.trim();
  if (!trimmed || /^available models:?$/iu.test(trimmed) || /^tip:/iu.test(trimmed)) return null;

  const hyphen = trimmed.match(/^([a-z0-9._/:+][a-z0-9._/:+-]*)\s+-\s+(.+?)\s*$/iu);
  if (hyphen) {
    const id = String(hyphen[1] ?? '').trim();
    const name = String(hyphen[2] ?? '').replace(/(?:\s*\((?:current|default)\))+$/iu, '').trim();
    return id && name ? { id, name } : null;
  }

  if (!trimmed.startsWith('-') && !trimmed.endsWith(':') && /^[a-z0-9._/:+-]+$/iu.test(trimmed)) {
    return { id: trimmed, name: trimmed };
  }

  return null;
}

function parseContextWindowFromName(name: string): string | undefined {
  const matches = Array.from(name.matchAll(/\b(\d+(?:k|m))\b/giu));
  const last = matches.at(-1)?.[1];
  return last ? normalizeToken(last) : undefined;
}

function parseCursorCliModelLines(stdout: string): ReadonlyArray<CursorCliModelLine> {
  const parsed: CursorCliModelLine[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = parseCursorModelsLine(rawLine);
    if (!line || seen.has(line.id)) continue;
    seen.add(line.id);
    parsed.push(line);
  }
  return parsed;
}

function groupCursorCliModelVariants(lines: ReadonlyArray<CursorCliModelLine>): ReadonlyArray<CursorCliModelGroup> {
  const groups = new Map<string, {
    id: string;
    name: string;
    variants: CursorCliModelVariant[];
  }>();

  for (const line of lines) {
    const normalizedBaseId = normalizeCursorModelVariantBaseId(line.id);
    const baseId = normalizeToken(normalizedBaseId) === 'auto' ? 'default' : normalizedBaseId;
    const traits = parseCursorCliTraits(line.id);
    const contextWindow = traits.contextWindow ?? parseContextWindowFromName(line.name);
    const variant: CursorCliModelVariant = {
      ...line,
      baseId,
      ...(typeof traits.fastMode === 'boolean' ? { fastMode: traits.fastMode } : {}),
      ...(typeof traits.thinking === 'boolean' ? { thinking: traits.thinking } : {}),
      ...(traits.reasoning ? { reasoning: traits.reasoning } : {}),
      ...(contextWindow ? { contextWindow } : {}),
    };

    const existing = groups.get(baseId);
    if (existing) {
      existing.variants.push(variant);
      if (line.id === baseId) existing.name = line.name;
      continue;
    }

    groups.set(baseId, {
      id: baseId,
      name: line.name,
      variants: [variant],
    });
  }

  return Array.from(groups.values());
}

function collectCursorCliControlValues(
  group: CursorCliModelGroup,
): ReadonlyMap<string, ReadonlySet<string>> {
  const values = new Map<string, Set<string>>();

  const add = (controlId: string, value: string): void => {
    const normalizedValue = normalizeToken(value);
    if (!normalizedValue) return;
    const existing = values.get(controlId) ?? new Set<string>();
    existing.add(normalizedValue);
    values.set(controlId, existing);
  };

  let hasFastVariant = false;
  let hasNonFastVariant = false;
  let hasThinkingVariant = false;
  let hasNonThinkingVariant = false;

  for (const variant of group.variants) {
    if (variant.fastMode === true) hasFastVariant = true;
    else hasNonFastVariant = true;

    if (variant.thinking === true) hasThinkingVariant = true;
    else hasNonThinkingVariant = true;

    if (variant.reasoning) add('reasoning_effort', variant.reasoning);
    if (variant.contextWindow) add('context', variant.contextWindow);
  }

  if (hasFastVariant && hasNonFastVariant) {
    add('fast', 'false');
    add('fast', 'true');
  }
  if (hasThinkingVariant && hasNonThinkingVariant) {
    add('thinking', 'false');
    add('thinking', 'true');
  }

  for (const [controlId, controlValues] of Array.from(values.entries())) {
    if (controlValues.size < 2) values.delete(controlId);
  }

  return values;
}

function buildCursorCliModelOptions(group: CursorCliModelGroup): ReadonlyArray<ProbedAgentModelOption> | undefined {
  const valuesByControlId = collectCursorCliControlValues(group);
  const options = Array.from(valuesByControlId.entries())
    .sort(([left], [right]) => sortModelParamControlIds(left, right))
    .map(([controlId, rawValues]) => {
      const sortedValues = Array.from(rawValues).sort((left, right) => sortModelParamValues(controlId, left, right));
      const currentValue: ProbedAgentModelOptionValue = controlId === 'fast' || controlId === 'thinking'
        ? 'false'
        : (sortedValues[0] ?? null);
      return {
        id: controlId,
        name: modelParamControlName(controlId),
        category: 'model_config',
        type: modelParamControlType(controlId, sortedValues),
        currentValue,
        options: sortedValues.map((value) => ({
          value,
          name: formatModelOptionChoiceLabel(controlId, value),
        })),
      };
    });

  return options.length > 0 ? options : undefined;
}

export function parseCursorCliModels(stdout: string): ReadonlyArray<ProbedAgentModel> | null {
  const lines = parseCursorCliModelLines(stdout);
  if (lines.length === 0) return null;

  const models = groupCursorCliModelVariants(lines)
    .map((group) => {
      const modelOptions = buildCursorCliModelOptions(group);
      return {
        id: group.id,
        name: group.name,
        ...(modelOptions ? { modelOptions } : {}),
      } satisfies ProbedAgentModel;
    });

  return models.length > 0 ? models : null;
}

function mergeModelOptions(
  primary: ReadonlyArray<ProbedAgentModelOption> | undefined,
  secondary: ReadonlyArray<ProbedAgentModelOption> | undefined,
): ReadonlyArray<ProbedAgentModelOption> | undefined {
  const merged: ProbedAgentModelOption[] = [];
  const seen = new Set<string>();
  for (const option of [...(primary ?? []), ...(secondary ?? [])]) {
    if (!option.id || seen.has(option.id)) continue;
    seen.add(option.id);
    merged.push(option);
  }
  return merged.length > 0 ? merged : undefined;
}

export function mergeCursorCliModelsIntoAcpModels(params: Readonly<{
  acpModels: ReadonlyArray<ProbedAgentModel>;
  cliModels: ReadonlyArray<ProbedAgentModel> | null | undefined;
}>): ReadonlyArray<ProbedAgentModel> {
  const cliModelsById = new Map((params.cliModels ?? []).map((model) => [model.id, model]));
  return params.acpModels.map((acpModel) => {
    const cliModel = cliModelsById.get(acpModel.id);
    if (!cliModel?.modelOptions?.length) return acpModel;
    const modelOptions = mergeModelOptions(acpModel.modelOptions, cliModel.modelOptions);
    return {
      ...acpModel,
      ...(modelOptions ? { modelOptions } : {}),
    };
  });
}

function stopChildProcess(child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32') {
    void killProcessTree(child, { graceMs: 250 }).catch(() => undefined);
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // best-effort
  }
}

export async function probeCursorCliModels(params: Readonly<{
  cwd: string;
  timeoutMs: number;
  processEnv: NodeJS.ProcessEnv;
}>): Promise<ReadonlyArray<ProbedAgentModel> | null> {
  const launch = requireProviderCliLaunchSpec('cursor', { processEnv: params.processEnv });
  const timeoutMs = Math.max(250, params.timeoutMs);
  return await new Promise((resolve) => {
    let stdout = '';
    let stdoutBytes = 0;
    let settled = false;

    const finish = (result: ReadonlyArray<ProbedAgentModel> | null): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const invocation = resolveWindowsCommandInvocation({
      command: launch.command,
      args: [...launch.args, 'models'],
      resolveCommandOnPath: true,
    });

    const child = spawn(invocation.command, invocation.args, {
      cwd: params.cwd,
      env: { ...params.processEnv, CI: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    const timer = setTimeout(() => {
      stopChildProcess(child);
      finish(null);
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > stdoutMaxBytes) {
        clearTimeout(timer);
        stopChildProcess(child);
        finish(null);
        return;
      }
      stdout += chunk.toString('utf8');
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (typeof code !== 'number' || code !== 0) return finish(null);
      finish(parseCursorCliModels(stdout));
    });
  });
}
