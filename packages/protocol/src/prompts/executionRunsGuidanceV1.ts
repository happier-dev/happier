import { buildBackendTargetKey, type BackendTargetRefV1 } from '../backends/targets/backendTargetRef.js';

export const EXECUTION_RUNS_GUIDANCE_INTENTS_V1 = ['review', 'plan', 'delegate'] as const;
export type ExecutionRunsGuidanceIntentV1 = (typeof EXECUTION_RUNS_GUIDANCE_INTENTS_V1)[number];

const EXECUTION_RUNS_GUIDANCE_INTENT_SET_V1 = new Set<string>(EXECUTION_RUNS_GUIDANCE_INTENTS_V1);

export function isExecutionRunsGuidanceIntentV1(intent: string): intent is ExecutionRunsGuidanceIntentV1 {
  return EXECUTION_RUNS_GUIDANCE_INTENT_SET_V1.has(String(intent ?? '').trim());
}

export type ExecutionRunsGuidanceEntryV1 = Readonly<{
  id: string;
  title?: string;
  description: string;
  enabled?: boolean;
  suggestedIntent?: ExecutionRunsGuidanceIntentV1;
  suggestedBackendTarget?: BackendTargetRefV1;
  suggestedModelId?: string;
  exampleToolCalls?: readonly string[];
}>;

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizeExecutionRunsGuidanceFingerprintV1(entry: ExecutionRunsGuidanceEntryV1): string {
  const description = normalizeWhitespace(entry.description).toLowerCase();
  const intent = entry.suggestedIntent ? entry.suggestedIntent.toLowerCase() : '';
  const backend = entry.suggestedBackendTarget ? buildBackendTargetKey(entry.suggestedBackendTarget).toLowerCase() : '';
  const model = typeof entry.suggestedModelId === 'string' ? entry.suggestedModelId.trim().toLowerCase() : '';
  return `${description}|${intent}|${backend}|${model}`;
}

export function buildExecutionRunsGuidanceBlockV1(params: Readonly<{
  entries: readonly ExecutionRunsGuidanceEntryV1[];
  maxChars: number;
}>): Readonly<{
  text: string;
  includedCount: number;
  remainingCount: number;
}> {
  const maxChars = Number.isFinite(params.maxChars) ? Math.max(0, Math.floor(params.maxChars)) : 0;
  if (maxChars < 1) return { text: '', includedCount: 0, remainingCount: 0 };

  const enabled = params.entries.filter((e) => e && e.enabled !== false);
  if (enabled.length === 0) return { text: '', includedCount: 0, remainingCount: 0 };

  const seen = new Set<string>();
  const unique: ExecutionRunsGuidanceEntryV1[] = [];
  for (const entry of enabled) {
    const fingerprint = normalizeExecutionRunsGuidanceFingerprintV1(entry);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    unique.push(entry);
  }
  if (unique.length === 0) return { text: '', includedCount: 0, remainingCount: 0 };

  const lines: string[] = [];
  lines.push('# Execution Runs Guidance');
  lines.push('');
  lines.push('These are user-configured guidance rules. Follow them when deciding whether/how to launch execution runs.');
  lines.push('');

  let usedChars = lines.join('\n').length;
  const tryPush = (line: string): boolean => {
    const nextLen = usedChars + 1 + line.length;
    if (nextLen > maxChars) return false;
    lines.push(line);
    usedChars = nextLen;
    return true;
  };
  let included = 0;
  const includedEntries: ExecutionRunsGuidanceEntryV1[] = [];

  for (const entry of unique) {
    const label = typeof entry.title === 'string' && entry.title.trim().length > 0 ? `${entry.title.trim()}: ` : '';
    const hints: string[] = [];
    if (entry.suggestedIntent) hints.push(`intent=${entry.suggestedIntent}`);
    if (entry.suggestedBackendTarget) hints.push(`backend=${buildBackendTargetKey(entry.suggestedBackendTarget)}`);
    if (entry.suggestedModelId) hints.push(`model=${entry.suggestedModelId}`);
    const suffix = hints.length > 0 ? ` (${hints.join(' ')})` : '';
    const text = `- ${label}${normalizeWhitespace(entry.description)}${suffix}`;
    const nextLen = usedChars + 1 + text.length;
    if (nextLen > maxChars) break;
    lines.push(text);
    usedChars = nextLen;
    included += 1;
    includedEntries.push(entry);
  }

  const remaining = unique.length - included;
  if (included === 0) {
    // If nothing fits, avoid injecting a mostly-empty guidance block.
    return { text: '', includedCount: 0, remainingCount: unique.length };
  }

  if (remaining > 0) {
    tryPush(`- (+${remaining} more rules in settings)`);
  }

  const exampleToolCalls = (() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of includedEntries) {
      const raw = entry.exampleToolCalls;
      if (!Array.isArray(raw) || raw.length === 0) continue;
      for (const call of raw) {
        if (typeof call !== 'string') continue;
        const normalized = normalizeWhitespace(call);
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(normalized);
      }
    }
    return out;
  })();

  if (exampleToolCalls.length > 0) {
    const first = `- ${exampleToolCalls[0]}`;
    // Add the section only if we can fit at least the header + intro + one bullet.
    const headerLines = ['', '## Example tool calls (MCP)', 'Examples only; adapt as needed.', first];
    const snapshot = { usedChars, linesLen: lines.length };
    let ok = true;
    for (const line of headerLines) {
      if (!tryPush(line)) {
        ok = false;
        break;
      }
    }

    if (!ok) {
      // Roll back partial section, keep the guidance rules block intact.
      lines.splice(snapshot.linesLen, lines.length - snapshot.linesLen);
      usedChars = snapshot.usedChars;
    } else {
      let includedExamples = 1;
      for (let i = 1; i < exampleToolCalls.length; i += 1) {
        if (!tryPush(`- ${exampleToolCalls[i]}`)) break;
        includedExamples += 1;
      }
      const remainingExamples = exampleToolCalls.length - includedExamples;
      if (remainingExamples > 0) {
        // Best-effort: only add the overflow note if it fits.
        tryPush(`- (+${remainingExamples} more examples in settings)`);
      }
    }
  }

  // Best-effort: include execution-run mechanics so the agent knows how to act on the rules.
  // Skip if it doesn't fit the character budget.
  const delegationLines = [
    '',
    '## Happier-Managed Execution Runs',
    'Use Happier execution runs when the user explicitly asks for Happier-managed reviews, plans, delegates, or voice agents, or when a configured rule above requires them.',
    '- Prefer provider-native subagent/delegation tools for native subagent work when those tools are available and the user did not ask for Happier-managed runs.',
    '- Backend targets choose agent provider/backend implementations; they are not parallelism slots or capacity controls.',
    '- Discover Happier run actions with `action_spec_search` or `action_spec_get`, resolve dynamic fields with `action_options_resolve`, then invoke the chosen action with `action_execute`.',
  ];
  {
    const snapshot = { usedChars, linesLen: lines.length };
    let ok = true;
    for (const line of delegationLines) {
      if (!tryPush(line)) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      lines.splice(snapshot.linesLen, lines.length - snapshot.linesLen);
      usedChars = snapshot.usedChars;
    }
  }

  return { text: lines.join('\n').trim(), includedCount: included, remainingCount: remaining };
}
