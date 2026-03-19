import {
  describeActionForVoiceTool,
  describeActionInputFieldForVoice,
  getActionVoiceWorkflowNotes,
  isVoicePromptHotPathSpec,
  type ActionInputFieldHint,
  type ActionSpec,
  type VoiceGuidanceAvailability,
} from '@happier-dev/protocol';

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function listStaticOptionValues(field: ActionInputFieldHint): string[] {
  const options = Array.isArray((field as any).options) ? ((field as any).options as Array<Record<string, unknown>>) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const option of options) {
    const value = normalizeText(option?.value);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function describeRequirement(field: ActionInputFieldHint): string {
  if ((field as any).required === true) return 'required';
  if ((field as any).requiredWhen || (field as any).visibleWhen) return 'conditional';
  return 'optional';
}

function formatFieldSummary(spec: ActionSpec, field: ActionInputFieldHint, availability: VoiceGuidanceAvailability): string | null {
  const path = normalizeText((field as any).path);
  if (!path) return null;
  const summary = describeActionInputFieldForVoice(spec, field, availability);
  const staticOptions = listStaticOptionValues(field);
  const optionSuffix = staticOptions.length > 0 ? ` one of ${staticOptions.join(' | ')}` : '';
  const widget = normalizeText((field as any).widget);
  const widgetSuffix = widget ? `; ${widget}` : '';
  return `    - ${path} (${describeRequirement(field)}${widgetSuffix}${optionSuffix}): ${summary}`;
}

function formatToolDocumentation(
  spec: ActionSpec,
  toolName: string,
  invocationLabel: string,
  availability: VoiceGuidanceAvailability,
): readonly string[] {
  const desc = normalizeText(describeActionForVoiceTool(spec)) || toolName;
  const argsExample = normalizeText(spec.examples?.voice?.argsExample) || '{}';
  const lines: string[] = [`- ${toolName}: ${desc} ${invocationLabel} ${argsExample}.`];

  const workflowNotes = getActionVoiceWorkflowNotes(spec.id, availability);
  if (workflowNotes.length > 0) {
    lines.push(`  Use: ${workflowNotes.join(' ')}`);
  }

  const fields = Array.isArray(spec.inputHints?.fields) ? (spec.inputHints?.fields as ActionInputFieldHint[]) : [];
  const fieldLines = fields.map((field) => formatFieldSummary(spec, field, availability)).filter(Boolean) as string[];
  if (fieldLines.length > 0) {
    lines.push('  Fields:');
    lines.push(...fieldLines);
  }

  return lines;
}

export function buildVoiceToolDocumentationLines(
  specs: readonly ActionSpec[],
  params: Readonly<{ disabledActionIds?: readonly string[]; invocationLabel: string }>,
): readonly string[] {
  const disabled = new Set((params.disabledActionIds ?? []).map((value) => normalizeText(value)).filter(Boolean));
  const enabledSpecs = specs.filter((spec) => isVoicePromptHotPathSpec(spec) && !disabled.has(spec.id));
  const availability: VoiceGuidanceAvailability = {
    disabledActionIds: params.disabledActionIds,
    availableActionIds: specs.filter((spec) => !disabled.has(spec.id)).map((spec) => spec.id),
  };
  const out: string[] = [];

  for (const spec of enabledSpecs) {
    const toolName = normalizeText(spec.bindings?.voiceClientToolName);
    if (!toolName) continue;
    out.push(...formatToolDocumentation(spec, toolName, params.invocationLabel, availability));
  }

  return out;
}

export function buildVoiceDiscoveryChecklistLines(
  specs: readonly ActionSpec[],
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
    for (const note of getActionVoiceWorkflowNotes(spec.id, availability)) {
      const normalized = normalizeText(note);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(`- ${normalized}`);
    }
  }

  return out;
}
