import { BackendTargetRefSchema } from '../backendTargets/backendTargetRef.js';
import { buildExecutionRunsGuidanceBlockV1, type ExecutionRunsGuidanceEntryV1 } from './executionRunsGuidanceV1.js';
import { buildMemoryRecallGuidanceBlockV1 } from './memoryRecallGuidanceV1.js';
import { buildPromptPlanV1, renderPromptPlanV1, type PromptPlanV1 } from './promptPlanV1.js';
import { HAPPIER_BASE_SYSTEM_PROMPT_V1 } from './systemPromptBaseV1.js';

function coerceExecutionRunsGuidanceEntriesV1(raw: unknown): ExecutionRunsGuidanceEntryV1[] {
  if (!Array.isArray(raw)) return [];

  const out: ExecutionRunsGuidanceEntryV1[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

    const id = typeof (item as Record<string, unknown>).id === 'string'
      ? String((item as Record<string, unknown>).id).trim()
      : '';
    const description = typeof (item as Record<string, unknown>).description === 'string'
      ? String((item as Record<string, unknown>).description)
      : '';
    if (!id || !description.trim()) continue;

    const title = typeof (item as Record<string, unknown>).title === 'string'
      ? String((item as Record<string, unknown>).title).trim()
      : '';
    const enabled = typeof (item as Record<string, unknown>).enabled === 'boolean'
      ? Boolean((item as Record<string, unknown>).enabled)
      : undefined;
    const suggestedIntentRaw = typeof (item as Record<string, unknown>).suggestedIntent === 'string'
      ? String((item as Record<string, unknown>).suggestedIntent).trim()
      : '';
    const suggestedIntent =
      suggestedIntentRaw === 'review' || suggestedIntentRaw === 'plan' || suggestedIntentRaw === 'delegate'
        ? suggestedIntentRaw
        : undefined;
    const suggestedBackendTargetParsed = BackendTargetRefSchema.safeParse(
      (item as Record<string, unknown>).suggestedBackendTarget,
    );
    const suggestedModelId = typeof (item as Record<string, unknown>).suggestedModelId === 'string'
      ? String((item as Record<string, unknown>).suggestedModelId).trim()
      : '';
    const exampleToolCallsRaw = (item as Record<string, unknown>).exampleToolCalls;
    const exampleToolCalls = Array.isArray(exampleToolCallsRaw)
      ? exampleToolCallsRaw
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean)
      : [];

    out.push({
      id,
      description,
      ...(title ? { title } : {}),
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
      ...(suggestedIntent ? { suggestedIntent } : {}),
      ...(suggestedBackendTargetParsed.success ? { suggestedBackendTarget: suggestedBackendTargetParsed.data } : {}),
      ...(suggestedModelId ? { suggestedModelId } : {}),
      ...(exampleToolCalls.length > 0 ? { exampleToolCalls } : {}),
    });
  }

  return out;
}

export function buildCodingSessionPromptPlanBaseV1(args: Readonly<{
  settings: Record<string, unknown> | null | undefined;
  base?: string;
  executionRunsFeatureEnabled: boolean;
  memoryRecallGuidanceEnabled?: boolean;
}>): PromptPlanV1 {
  const base = typeof args.base === 'string' ? args.base : HAPPIER_BASE_SYSTEM_PROMPT_V1;
  const settings = args.settings && typeof args.settings === 'object' && !Array.isArray(args.settings)
    ? args.settings
    : null;

  const blocks = [{
    id: 'coding.base',
    scope: 'session' as const,
    text: base.trim(),
  }];

  if (args.memoryRecallGuidanceEnabled === true) {
    blocks.push({
      id: 'coding.memory_recall',
      scope: 'session' as const,
      text: buildMemoryRecallGuidanceBlockV1('generic'),
    });
  }

  if (!args.executionRunsFeatureEnabled) {
    return buildPromptPlanV1({ modality: 'coding', blocks });
  }
  if (settings?.executionRunsGuidanceEnabled !== true) {
    return buildPromptPlanV1({ modality: 'coding', blocks });
  }

  const maxCharsRaw = settings?.executionRunsGuidanceMaxChars;
  const maxChars = typeof maxCharsRaw === 'number' && Number.isFinite(maxCharsRaw) && maxCharsRaw >= 200
    ? Math.floor(maxCharsRaw)
    : 4_000;
  const entries = coerceExecutionRunsGuidanceEntriesV1(settings?.executionRunsGuidanceEntries);
  const guidance = buildExecutionRunsGuidanceBlockV1({ entries, maxChars }).text;

  if (guidance) {
    blocks.push({
      id: 'coding.execution_runs',
      scope: 'session' as const,
      text: guidance,
    });
  }
  return buildPromptPlanV1({ modality: 'coding', blocks });
}

export function buildAppendSystemPromptBaseV1(args: Readonly<{
  settings: Record<string, unknown> | null | undefined;
  base?: string;
  executionRunsFeatureEnabled: boolean;
  memoryRecallGuidanceEnabled?: boolean;
}>): string {
  return renderPromptPlanV1(buildCodingSessionPromptPlanBaseV1(args));
}
