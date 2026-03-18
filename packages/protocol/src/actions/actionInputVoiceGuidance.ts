import type { ActionInputFieldHint, ActionSpec } from './actionSpecs.js';
import type { ActionInputPredicate } from './actionInputPredicates.js';

type VoiceGuidanceNote = Readonly<{
  text: string;
  requiresActionIds?: readonly string[];
}>;

export type VoiceGuidanceAvailability = Readonly<{
  disabledActionIds?: readonly string[];
  availableActionIds?: readonly string[];
}>;

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function joinSentences(parts: readonly (string | null | undefined)[]): string {
  return parts
    .map((part) => normalizeText(part))
    .filter(Boolean)
    .map((part) => {
      const trimmed = part!;
      return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
    })
    .join(' ');
}

function formatPredicateValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return 'value';
}

function describePredicate(predicate: ActionInputPredicate | undefined): string | null {
  if (!predicate || typeof predicate !== 'object') return null;
  switch ((predicate as any).op) {
    case 'truthy':
      return `when ${String((predicate as any).path ?? '').trim()} is set`;
    case 'eq':
      return `when ${String((predicate as any).path ?? '').trim()}=${formatPredicateValue((predicate as any).value)}`;
    case 'includes':
      return `when ${String((predicate as any).path ?? '').trim()} includes ${String((predicate as any).value ?? '').trim()}`;
    case 'not': {
      const nested = describePredicate((predicate as any).predicate);
      return nested ? `when not (${nested})` : null;
    }
    case 'and': {
      const all = Array.isArray((predicate as any).all) ? ((predicate as any).all as ActionInputPredicate[]) : [];
      const parts = all.map((entry) => describePredicate(entry)).filter(Boolean);
      return parts.length > 0 ? parts.join(' and ') : null;
    }
    case 'or': {
      const any = Array.isArray((predicate as any).any) ? ((predicate as any).any as ActionInputPredicate[]) : [];
      const parts = any.map((entry) => describePredicate(entry)).filter(Boolean);
      return parts.length > 0 ? parts.join(' or ') : null;
    }
    default:
      return null;
  }
}

const FIELD_GUIDANCE_BY_OPTIONS_SOURCE_ID: Readonly<Record<string, readonly VoiceGuidanceNote[]>> = Object.freeze({
  'review.engines.available': [{ text: 'Use listReviewEngines to discover review engines by name before choosing engineIds internally', requiresActionIds: ['review.engines.list'] }],
  'execution.backends.enabled': [{ text: 'Use listAgentBackends to discover backends by name before choosing backendTargetKeys internally', requiresActionIds: ['agents.backends.list'] }],
});

const FIELD_GUIDANCE_BY_ACTION_ID: Readonly<Record<string, Readonly<Record<string, readonly VoiceGuidanceNote[]>>>> = Object.freeze({
  'review.start': {
    sessionId: [{ text: 'Optional when the active target session is already correct' }],
  },
  'subagents.plan.start': {
    sessionId: [{ text: 'Optional when the active target session is already correct' }],
  },
  'subagents.delegate.start': {
    sessionId: [{ text: 'Optional when the active target session is already correct' }],
  },
  'voice_agent.start': {
    sessionId: [{ text: 'Optional when the active target session is already correct' }],
  },
  'agents.models.list': {
    agentId: [{ text: 'Use listAgentBackends first if you do not already know the backend name', requiresActionIds: ['agents.backends.list'] }],
    limit: [{ text: 'Set limit when the user only needs a few results' }],
  },
  'execution.run.get': {
    runId: [{ text: 'Use listExecutionRuns to discover runs by title or status before choosing runId internally', requiresActionIds: ['execution.run.list'] }],
  },
  'execution.run.send': {
    runId: [{ text: 'Use listExecutionRuns to discover runs by title or status before choosing runId internally', requiresActionIds: ['execution.run.list'] }],
  },
  'execution.run.stop': {
    runId: [{ text: 'Use listExecutionRuns to discover runs by title or status before choosing runId internally', requiresActionIds: ['execution.run.list'] }],
  },
  'execution.run.action': {
    runId: [{ text: 'Use listExecutionRuns to discover runs by title or status before choosing runId internally', requiresActionIds: ['execution.run.list'] }],
    actionId: [{ text: 'Use getExecutionRun after choosing runId to inspect available actions before choosing actionId internally', requiresActionIds: ['execution.run.get'] }],
  },
  'session.open': {
    sessionId: [{ text: 'Use listSessions to discover sessions by title before choosing sessionId internally', requiresActionIds: ['session.list'] }],
  },
  'session.fork': {
    sessionId: [
      { text: 'Optional when the active target session is already correct' },
      { text: 'Use listSessions to discover sessions by title before choosing sessionId internally', requiresActionIds: ['session.list'] },
    ],
  },
  'session.spawn_new': {
    agentId: [{ text: 'Use listAgentBackends to discover backends by name before choosing agentId internally', requiresActionIds: ['agents.backends.list'] }],
    modelId: [{ text: 'Use listAgentModels after choosing agentId so you can pick a model by name internally', requiresActionIds: ['agents.models.list'] }],
    path: [
      { text: 'Prefer spawnSessionPicker unless the user explicitly named a path', requiresActionIds: ['session.spawn_picker'] },
      { text: 'Use listRecentPaths when you need a recent path handle', requiresActionIds: ['paths.list_recent'] },
    ],
    host: [{ text: 'Use listMachines to discover machines by label before choosing host internally', requiresActionIds: ['machines.list'] }],
  },
  'session.spawn_picker': {
    agentId: [{ text: 'Use listAgentBackends to discover backends by name before choosing agentId internally', requiresActionIds: ['agents.backends.list'] }],
    modelId: [{ text: 'Use listAgentModels after choosing agentId so you can pick a model by name internally', requiresActionIds: ['agents.models.list'] }],
  },
  'session.permission.respond': {
    requestId: [{ text: 'Optional when only one permission request is pending' }],
  },
  'session.user_action.answer': {
    requestId: [{ text: 'Optional when only one user-action request is pending' }],
  },
  'session.message.send': {
    sessionId: [{ text: 'Optional when the active target session is already correct' }],
  },
  'session.target.primary.set': {
    sessionId: [{ text: 'Use listSessions to discover sessions by title before choosing sessionId internally', requiresActionIds: ['session.list'] }],
  },
  'session.target.tracked.set': {
    sessionIds: [{ text: 'Use listSessions to discover sessions by title before choosing sessionIds internally', requiresActionIds: ['session.list'] }],
  },
  'session.activity.get': {
    sessionId: [{ text: 'Use listSessions to discover sessions by title before choosing sessionId internally', requiresActionIds: ['session.list'] }],
  },
  'session.messages.recent.get': {
    sessionId: [{ text: 'Use listSessions to discover sessions by title before choosing sessionId internally', requiresActionIds: ['session.list'] }],
  },
  'memory.search': {
    machineId: [{ text: 'Use listMachines to discover machines by label before choosing machineId internally', requiresActionIds: ['machines.list'] }],
  },
  'memory.get_window': {
    machineId: [{ text: 'Use memorySearch first so you already have machineId, sessionId, seqFrom, and seqTo', requiresActionIds: ['memory.search'] }],
    sessionId: [{ text: 'Use memorySearch first so you already have machineId, sessionId, seqFrom, and seqTo', requiresActionIds: ['memory.search'] }],
    seqFrom: [{ text: 'Use memorySearch first so you already have machineId, sessionId, seqFrom, and seqTo', requiresActionIds: ['memory.search'] }],
    seqTo: [{ text: 'Use memorySearch first so you already have machineId, sessionId, seqFrom, and seqTo', requiresActionIds: ['memory.search'] }],
  },
  'memory.ensure_up_to_date': {
    machineId: [{ text: 'Use listMachines to discover machines by label before choosing machineId internally', requiresActionIds: ['machines.list'] }],
    sessionId: [{ text: 'Optional when you want to refresh all active sessions on the machine' }],
  },
});

const WORKFLOW_NOTES_BY_ACTION_ID: Readonly<Record<string, readonly VoiceGuidanceNote[]>> = Object.freeze({
  'review.start': [{ text: 'Use listReviewEngines before guessing engineIds from engine names', requiresActionIds: ['review.engines.list'] }],
  'subagents.plan.start': [{ text: 'Use listAgentBackends before choosing backendTargetKeys internally', requiresActionIds: ['agents.backends.list'] }],
  'subagents.delegate.start': [{ text: 'Use listAgentBackends before choosing backendTargetKeys internally', requiresActionIds: ['agents.backends.list'] }],
  'voice_agent.start': [{ text: 'Use listAgentBackends before choosing backendTargetKeys internally', requiresActionIds: ['agents.backends.list'] }],
  'agents.models.list': [{ text: 'Call listAgentBackends first if you do not already know the backend name', requiresActionIds: ['agents.backends.list'] }],
  'execution.run.get': [{ text: 'Use listExecutionRuns before choosing runId internally', requiresActionIds: ['execution.run.list'] }],
  'execution.run.send': [{ text: 'Use listExecutionRuns before choosing runId internally', requiresActionIds: ['execution.run.list'] }],
  'execution.run.stop': [{ text: 'Use listExecutionRuns before choosing runId internally', requiresActionIds: ['execution.run.list'] }],
  'execution.run.action': [
    { text: 'Use listExecutionRuns before choosing runId internally', requiresActionIds: ['execution.run.list'] },
    { text: 'Use getExecutionRun after choosing runId to inspect available actions before choosing actionId internally', requiresActionIds: ['execution.run.get'] },
  ],
  'session.open': [
    { text: 'If you already know the exact human session title, pass sessionTitle directly instead of asking for a raw session id', requiresActionIds: ['session.list'] },
    { text: 'Use listSessions before choosing sessionId internally', requiresActionIds: ['session.list'] },
    { text: 'If the exact session title is not in the first listSessions page, continue with its next cursor or use spawnSessionPicker', requiresActionIds: ['session.list'] },
  ],
  'session.fork': [
    { text: 'Use listSessions before choosing sessionId internally when the active target session is not already correct', requiresActionIds: ['session.list'] },
    { text: 'If the exact session title is not in the first listSessions page, continue with its next cursor or use spawnSessionPicker', requiresActionIds: ['session.list'] },
  ],
  'session.spawn_new': [
    { text: 'Prefer spawnSessionPicker if the user has not already chosen an exact path', requiresActionIds: ['session.spawn_picker'] },
    { text: 'Use listRecentPaths instead of guessing raw paths', requiresActionIds: ['paths.list_recent'] },
    { text: 'Use listAgentBackends before setting agentId internally', requiresActionIds: ['agents.backends.list'] },
    { text: 'Use listAgentModels before setting modelId internally', requiresActionIds: ['agents.models.list'] },
  ],
  'session.spawn_picker': [
    { text: 'Use spawnSessionPicker when the user needs to choose a machine or directory in the UI', requiresActionIds: ['session.spawn_picker'] },
    {
      text: 'When the user asks to choose a machine or directory in the UI, call spawnSessionPicker instead of only saying you will open it',
      requiresActionIds: ['session.spawn_picker'],
    },
  ],
  'session.target.primary.set': [
    { text: 'If you already know the exact human session title, pass sessionTitle directly instead of asking for a raw session id', requiresActionIds: ['session.list'] },
    { text: 'Use listSessions before choosing sessionId internally', requiresActionIds: ['session.list'] },
    { text: 'If the exact session title is not in the first listSessions page, continue with its next cursor or use spawnSessionPicker', requiresActionIds: ['session.list'] },
  ],
  'session.target.tracked.set': [
    { text: 'Use listSessions before choosing sessionIds internally', requiresActionIds: ['session.list'] },
    { text: 'If the exact session title is not in the first listSessions page, continue with its next cursor or use spawnSessionPicker', requiresActionIds: ['session.list'] },
  ],
  'session.activity.get': [
    { text: 'Use listSessions before choosing sessionId internally', requiresActionIds: ['session.list'] },
    { text: 'If the exact session title is not in the first listSessions page, continue with its next cursor or use spawnSessionPicker', requiresActionIds: ['session.list'] },
  ],
  'session.messages.recent.get': [
    { text: 'Use listSessions before choosing sessionId internally', requiresActionIds: ['session.list'] },
    { text: 'If the exact session title is not in the first listSessions page, continue with its next cursor or use spawnSessionPicker', requiresActionIds: ['session.list'] },
  ],
  'memory.search': [{ text: 'Use listMachines before choosing machineId internally', requiresActionIds: ['machines.list'] }],
  'memory.get_window': [{ text: 'Use memorySearch before calling memoryGetWindow so you already have machineId, sessionId, seqFrom, and seqTo', requiresActionIds: ['memory.search'] }],
  'memory.ensure_up_to_date': [{ text: 'Use listMachines before choosing machineId internally', requiresActionIds: ['machines.list'] }],
});

function normalizeGuidanceAvailability(params: VoiceGuidanceAvailability | undefined): Readonly<{
  disabledActionIds: ReadonlySet<string>;
  availableActionIds: ReadonlySet<string> | null;
}> {
  const disabledActionIds = new Set(
    (params?.disabledActionIds ?? []).map((value) => normalizeText(value)).filter(Boolean) as string[],
  );
  const availableRaw = (params?.availableActionIds ?? []).map((value) => normalizeText(value)).filter(Boolean) as string[];
  return {
    disabledActionIds,
    availableActionIds: availableRaw.length > 0 ? new Set(availableRaw) : null,
  };
}

function isGuidanceNoteAvailable(note: VoiceGuidanceNote, availability: VoiceGuidanceAvailability | undefined): boolean {
  const requiredActionIds = (note.requiresActionIds ?? []).map((value) => normalizeText(value)).filter(Boolean) as string[];
  if (requiredActionIds.length === 0) return true;
  const normalized = normalizeGuidanceAvailability(availability);
  if (requiredActionIds.some((actionId) => normalized.disabledActionIds.has(actionId))) {
    return false;
  }
  if (normalized.availableActionIds && requiredActionIds.some((actionId) => !normalized.availableActionIds!.has(actionId))) {
    return false;
  }
  return true;
}

function resolveVoiceGuidanceNotes(notes: readonly VoiceGuidanceNote[], availability: VoiceGuidanceAvailability | undefined): readonly string[] {
  const seen = new Set<string>();
  return notes
    .filter((note) => isGuidanceNoteAvailable(note, availability))
    .map((note) => normalizeText(note.text))
    .filter(Boolean)
    .filter((note) => {
      if (seen.has(note!)) return false;
      seen.add(note!);
      return true;
    }) as string[];
}

export function getActionVoiceWorkflowNotes(actionId: string, availability?: VoiceGuidanceAvailability): readonly string[] {
  return resolveVoiceGuidanceNotes(WORKFLOW_NOTES_BY_ACTION_ID[actionId] ?? [], availability);
}

function listStaticOptionValues(field: ActionInputFieldHint): string[] {
  const options = Array.isArray((field as any).options) ? ((field as any).options as Array<Record<string, unknown>>) : [];
  const values = options
    .map((option) => normalizeText(option?.value))
    .filter(Boolean) as string[];
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export function getActionInputFieldVoiceNotes(
  spec: Pick<ActionSpec, 'id'>,
  field: ActionInputFieldHint,
  availability?: VoiceGuidanceAvailability,
): readonly string[] {
  const notes: VoiceGuidanceNote[] = [];
  const byOptionsSource = normalizeText((field as any).optionsSourceId);
  if (byOptionsSource) {
    notes.push(...(FIELD_GUIDANCE_BY_OPTIONS_SOURCE_ID[byOptionsSource] ?? []));
  }
  const byPath = FIELD_GUIDANCE_BY_ACTION_ID[spec.id]?.[String((field as any).path ?? '').trim()] ?? [];
  notes.push(...byPath);
  return resolveVoiceGuidanceNotes(notes, availability);
}

export function describeActionInputFieldForVoice(
  spec: Pick<ActionSpec, 'id'>,
  field: ActionInputFieldHint,
  availability?: VoiceGuidanceAvailability,
): string {
  const baseDescription = normalizeText((field as any).description) ?? normalizeText((field as any).title);
  const staticOptions = listStaticOptionValues(field);
  const optionDescription =
    staticOptions.length > 0 ? `Allowed values: ${staticOptions.join(' | ')}` : null;
  const conditionDescription =
    describePredicate((field as any).requiredWhen) ??
    describePredicate((field as any).visibleWhen) ??
    null;
  const conditionSentence = conditionDescription ? `Only use this ${conditionDescription}` : null;
  const notes = getActionInputFieldVoiceNotes(spec, field, availability);

  return joinSentences([baseDescription, optionDescription, conditionSentence, ...notes]);
}
