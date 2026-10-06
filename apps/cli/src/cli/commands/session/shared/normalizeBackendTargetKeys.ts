import { BackendTargetKeySchema, buildBackendTargetKey } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { BackendTargetKeyV2Schema, convertBackendTargetRefV2ToV1, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { parseBackendTargetKey } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import { getAgentCatalogDefinition } from '@happier-dev/agents';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import type { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import {
  normalizeActionExecuteResult,
  unwrapCliActionSuccessPayload,
} from './normalizeActionExecuteResult';

type BackendTargetOptionsActionId =
  | 'subagents.delegate.start'
  | 'subagents.plan.start'
  | 'voice_agent.start';

type BackendTargetOptionsExecutor = Pick<ReturnType<typeof createCliActionExecutor>, 'execute'>;

type ResolvedBackendTargetOption = Readonly<{
  value: string;
  label: string;
  disabled: boolean;
}>;

function readBackendTargetEntriesFromCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function readBackendTargetAliases(value: string): string[] {
  const v2Target = BackendTargetKeyV2Schema.safeParse(value);
  if (v2Target.success) {
    const parsed = parseBackendTargetKeyV2(v2Target.data);
    if (parsed.kind === 'agent') {
      return [parsed.identity.localId];
    }
    return parsed.configuredBackendId
      ? [parsed.backendId, parsed.configuredBackendId]
      : [parsed.backendId];
  }

  const legacyTarget = BackendTargetKeySchema.safeParse(value);
  if (!legacyTarget.success) return [];
  const parsed = parseBackendTargetKey(legacyTarget.data);
  return [parsed.kind === 'builtInAgent' ? parsed.agentId : parsed.backendId];
}

function readResolvedBackendTargetOptions(result: unknown): ResolvedBackendTargetOption[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Unable to resolve available backend targets.');
  }
  const options = (result as { options?: unknown }).options;
  if (!Array.isArray(options)) {
    throw new Error('Unable to resolve available backend targets.');
  }

  return options.flatMap((option): ResolvedBackendTargetOption[] => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) return [];
    const optionValue = (option as { value?: unknown }).value;
    const label = (option as { label?: unknown }).label;
    if (typeof optionValue !== 'string' || !optionValue.trim() || typeof label !== 'string' || !label.trim()) {
      return [];
    }
    return [{ value: optionValue, label, disabled: (option as { disabled?: unknown }).disabled === true }];
  });
}

function resolveBackendTargetEntry(params: Readonly<{
  entry: string;
  options: readonly ResolvedBackendTargetOption[];
}>): string {
  const exactMatches = params.options.filter((option) => option.value === params.entry);
  const normalizedEntry = normalizeSearchText(params.entry);
  const normalizedEntryAliases = readBackendTargetAliases(params.entry)
    .map((alias) => normalizeSearchText(alias));
  const matches = exactMatches.length > 0
    ? exactMatches
    : params.options.filter((option) => (
      normalizeSearchText(option.label) === normalizedEntry
      || readBackendTargetAliases(option.value).some((alias) => {
        const normalizedAlias = normalizeSearchText(alias);
        return normalizedAlias === normalizedEntry || normalizedEntryAliases.includes(normalizedAlias);
      })
    ));

  if (matches.length === 0) {
    throw new Error(`Invalid backend target "${params.entry}": no matching target.`);
  }
  if (matches.length > 1) {
    throw new Error(`Invalid backend target "${params.entry}": ambiguous.`);
  }
  if (matches[0].disabled) {
    throw new Error(`Invalid backend target "${params.entry}": disabled.`);
  }
  return matches[0].value;
}

function normalizeBackendTargetKeyFromInput(entry: string): string | null {
  const parsedV2 = BackendTargetKeyV2Schema.safeParse(entry);
  if (parsedV2.success) {
    return parsedV2.data;
  }

  const parsed = BackendTargetKeySchema.safeParse(entry);
  if (parsed.success) {
    const backendTarget = parseBackendTargetKey(parsed.data);
    if (backendTarget.kind === 'builtInAgent' && backendTarget.agentId === 'customAcp') {
      return null;
    }
    return parsed.data;
  }

  if (entry === 'customAcp') {
    return null;
  }

  const settingsBackendId = getAgentCatalogDefinition(entry)?.settingsBackendId?.trim();
  if (settingsBackendId) {
    return buildBackendTargetKeyV2({
      kind: 'backend',
      backendId: settingsBackendId,
      configuredBackendId: settingsBackendId,
      sourceKind: 'configured',
    });
  }

  return buildBackendTargetKey({ kind: 'builtInAgent', agentId: entry });
}

export function normalizeBackendTargetKeysFromCsv(value: string | null): string[] {
  return readBackendTargetEntriesFromCsv(value)
    .map((entry) => normalizeBackendTargetKeyFromInput(entry))
    .filter((entry): entry is string => Boolean(entry));
}

export function hasBackendTargetSelectionFromCsv(value: string | null): boolean {
  return readBackendTargetEntriesFromCsv(value).length > 0;
}

/**
 * Resolves Session-bound start targets through the Action's current options
 * source. Session creation has no target Session and continues to use the
 * legacy spawn-input normalizer above; it is not an alternate catalog here.
 */
export async function resolveBackendTargetKeysFromCsv(params: Readonly<{
  value: string | null;
  actionId: BackendTargetOptionsActionId;
  sessionId: string;
  executor: BackendTargetOptionsExecutor;
}>): Promise<string[]> {
  const entries = readBackendTargetEntriesFromCsv(params.value);
  if (entries.length === 0) return [];

  const actionResult = normalizeActionExecuteResult(await params.executor.execute(
    'action.options.resolve',
    {
      actionId: params.actionId,
      fieldPath: 'backendTargetKeys',
      optionsSourceId: 'execution.backends.enabled',
      sessionId: params.sessionId,
      includeDisabled: true,
    },
    { surface: 'cli', defaultSessionId: params.sessionId },
  ));
  if (!actionResult.ok) {
    throw new Error(
      actionResult.errorMessage ?? `Unable to resolve available backend targets: ${actionResult.errorCode}.`,
    );
  }

  const options = readResolvedBackendTargetOptions(unwrapCliActionSuccessPayload(actionResult.data));
  return entries.map((entry) => resolveBackendTargetEntry({ entry, options }));
}

export function parseSingleBackendTargetFromFlag(value: string | null): BackendTargetRefV1 | null {
  const backendTargetKeys = normalizeBackendTargetKeysFromCsv(value);
  if (backendTargetKeys.length !== 1) {
    return null;
  }

  const key = backendTargetKeys[0];
  const parsed = parseBackendTargetKeyV2(key);
  if (parsed.kind === 'agent') {
    const definition = [...readAgentCatalogSnapshot().agentDefinitionsById.values()].find((candidate) => (
      candidate.identity !== undefined
      && candidate.identity.pluginId === parsed.identity.pluginId
      && candidate.identity.localId === parsed.identity.localId
    ));
    if (!definition) return null;
    return { kind: 'builtInAgent', agentId: definition.id };
  }
  return convertBackendTargetRefV2ToV1(readBackendTargetRefV2(key));
}
