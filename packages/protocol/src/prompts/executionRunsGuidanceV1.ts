import { buildBackendTargetKey, type BackendTargetRefV1 } from '../backendTargets/backendTargetRef.js';

type ExecutionRunsGuidanceIntentV1 = 'review' | 'plan' | 'delegate';

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

const BUILT_IN_EXECUTION_RUNS_GUIDANCE_V1 = `# Happier-Managed Runs

Use the current backend's native subagent facility by default. Treat generic requests for a subagent, delegation, or parallel agents as native-subagent requests. Use Happier-managed execution or delegation runs only when the user explicitly requests a Happier-managed run, delegation, or subagent, or explicitly requests a subagent on another backend, provider, model, account, or service that native subagents cannot satisfy. Do not silently change backend or execution topology when native subagents fail or are unavailable.

- Explicit Happier wording includes “Happier subagent,” “Happier delegation run,” and “Happier execution run.” Only then discover actions with \`action_spec_search\` or \`action_spec_get\` and invoke them with \`action_execute\`.
- Prefer \`subagents.delegate.start\` for bounded delegation and \`execution.run.start\` for lower-level control. Do not use \`session.spawn_new\` for routine delegation.
- In a session-agent call, omit \`sessionId\` to use the current invoking session. Supply it only for an intentional explicit cross-session target.
- Resolve dependent values through \`action_options_resolve\` (the \`action.options.resolve\` action) with the partial action draft. Backend targets select provider/backend implementations, not parallelism slots. Respect the requested backend, model, account, and service.
- A typed retryable rate limit may be retried; backend substitution requires authorization.
- Use start-and-wait or \`execution.run.wait\` for bounded observation. A wait timeout means the run may still be active.`;

export function buildExecutionRunsGuidanceBlockV1(params: Readonly<{
  entries: readonly ExecutionRunsGuidanceEntryV1[];
  maxChars: number;
}>): Readonly<{
  text: string;
  includedCount: number;
  remainingCount: number;
}> {
  const maxChars = Number.isFinite(params.maxChars) ? Math.max(0, Math.floor(params.maxChars)) : 0;
  const enabled = params.entries.filter((e) => e && e.enabled !== false);

  const seen = new Set<string>();
  const unique: ExecutionRunsGuidanceEntryV1[] = [];
  for (const entry of enabled) {
    const fingerprint = normalizeExecutionRunsGuidanceFingerprintV1(entry);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    unique.push(entry);
  }
  if (unique.length === 0 || maxChars < 1) {
    return {
      text: BUILT_IN_EXECUTION_RUNS_GUIDANCE_V1,
      includedCount: 0,
      remainingCount: unique.length,
    };
  }

  const lines: string[] = [];
  lines.push('# Custom Execution-Run Rules');
  lines.push('');
  lines.push('These user-configured rules may also require a Happier-managed run.');
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
    return { text: BUILT_IN_EXECUTION_RUNS_GUIDANCE_V1, includedCount: 0, remainingCount: unique.length };
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

  return {
    text: `${BUILT_IN_EXECUTION_RUNS_GUIDANCE_V1}\n\n${lines.join('\n').trim()}`,
    includedCount: included,
    remainingCount: remaining,
  };
}
