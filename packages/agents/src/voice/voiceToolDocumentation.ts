import { describeActionForVoiceTool } from '@happier-dev/protocol/actions/actionVoiceToolSummary';
import { isVoicePromptHotPathSpec, listVoiceToolActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { getActionVoiceWorkflowNotes } from '@happier-dev/protocol/actions/actionInputVoiceGuidance';
import type { VoiceGuidanceAvailability } from '@happier-dev/protocol/actions/actionInputVoiceGuidance';

export type VoicePromptActionSpec = Pick<
  ActionSpec,
  'id' | 'title' | 'description' | 'bindings' | 'examples' | 'inputHints' | 'prompting' | 'surfaceBindings'
>;

// Built on first use: deriving it at module evaluation built the whole Action
// catalog in every process that imports this module (daemon, session host).
let voiceToolNameByActionId: ReadonlyMap<string, string> | undefined;
function readVoiceToolNameByActionId(): ReadonlyMap<string, string> {
  return voiceToolNameByActionId ??= new Map(
    listVoiceToolActionSpecs().flatMap((spec) => {
      const name = spec.bindings?.voiceClientToolName;
      return typeof name === 'string' && name ? [[spec.id, name] as const] : [];
    }),
  );
}

function referencesUnavailableVoiceTool(
  text: string,
  availability: VoiceGuidanceAvailability,
): boolean {
  const available = new Set(availability.availableActionIds ?? []);
  for (const [actionId, toolName] of readVoiceToolNameByActionId()) {
    if (!available.has(actionId) && text.includes(toolName)) return true;
  }
  return false;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function buildVoiceToolDocumentationLines(
  specs: readonly VoicePromptActionSpec[],
  params: Readonly<{
    disabledActionIds?: readonly string[];
    includeAllTools?: boolean;
  }>,
): readonly string[] {
  const disabled = new Set((params.disabledActionIds ?? []).map((value) => normalizeText(value)).filter(Boolean));
  const enabledSpecs = specs.filter((spec) => (
    params.includeAllTools || isVoicePromptHotPathSpec(spec)
  ) && !disabled.has(spec.id));
  const availability: VoiceGuidanceAvailability = {
    disabledActionIds: params.disabledActionIds,
    availableActionIds: specs.filter((spec) => !disabled.has(spec.id)).map((spec) => spec.id),
  };
  const out: string[] = [];

  for (const spec of enabledSpecs) {
    const toolName = normalizeText(spec.bindings?.voiceClientToolName);
    if (!toolName) continue;
    // The prompt is an index. Full inputs and examples remain in getActionSpec
    // and the provider's structured tools instead of growing every Voice seed.
    const purpose = normalizeText(describeActionForVoiceTool(spec)).replace(/\s+/g, ' ') || toolName;
    const line = `- ${toolName}: ${purpose}`;
    if (!referencesUnavailableVoiceTool(line, availability)) out.push(line);
  }

  return out;
}

export function buildVoiceDiscoveryChecklistLines(
  specs: readonly VoicePromptActionSpec[],
  params?: Readonly<{ disabledActionIds?: readonly string[] }>,
): readonly string[] {
  const disabled = new Set((params?.disabledActionIds ?? []).map((value) => normalizeText(value)).filter(Boolean));
  const enabledSpecs = specs.filter((spec) => !disabled.has(spec.id));
  const availability: VoiceGuidanceAvailability = {
    disabledActionIds: params?.disabledActionIds,
    availableActionIds: enabledSpecs.map((spec) => spec.id),
  };
  const seen = new Set<string>();
  const out: string[] = [];

  for (const spec of enabledSpecs) {
    // Keep workflow guidance once, independently of the compact action index.
    for (const note of getActionVoiceWorkflowNotes(spec.id, availability)) {
      const normalized = normalizeText(note);
      if (!normalized
        || seen.has(normalized)
        || referencesUnavailableVoiceTool(normalized, availability)) continue;
      seen.add(normalized);
      out.push(`- ${normalized}`);
    }
  }

  return out;
}
