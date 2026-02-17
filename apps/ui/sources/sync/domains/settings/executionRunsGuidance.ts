import type { AgentId } from '@/agents/catalog/catalog';
import { isAgentId } from '@/agents/catalog/catalog';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';

type ExecutionRunsGuidanceIntent = 'review' | 'plan' | 'delegate';

export type ExecutionRunsGuidanceEntry = Readonly<{
    id: string;
    title?: string;
    description: string;
    enabled?: boolean;
    suggestedIntent?: ExecutionRunsGuidanceIntent;
    suggestedBackendId?: AgentId;
    suggestedModelId?: ModelMode;
    exampleToolCalls?: readonly string[];
}>;

function normalizeWhitespace(value: string): string {
    return value.trim().replace(/\s+/g, ' ');
}

export function coerceExecutionRunsGuidanceEntries(raw: unknown): ExecutionRunsGuidanceEntry[] {
    if (!Array.isArray(raw)) return [];
    const out: ExecutionRunsGuidanceEntry[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const id = (item as any).id;
        const description = (item as any).description;
        if (typeof id !== 'string' || id.trim().length === 0) continue;
        if (typeof description !== 'string' || description.trim().length === 0) continue;

        const title = (item as any).title;
        const enabled = (item as any).enabled;
        const suggestedIntentRaw = (item as any).suggestedIntent;
        const suggestedBackendIdRaw = (item as any).suggestedBackendId;
        const suggestedModelIdRaw = (item as any).suggestedModelId;
        const exampleToolCallsRaw = (item as any).exampleToolCalls;

        const suggestedIntent =
            suggestedIntentRaw === 'review' || suggestedIntentRaw === 'plan' || suggestedIntentRaw === 'delegate'
                ? suggestedIntentRaw
                : undefined;

        const suggestedBackendId = (() => {
            if (typeof suggestedBackendIdRaw !== 'string') return undefined;
            const trimmed = suggestedBackendIdRaw.trim();
            if (!trimmed) return undefined;
            return isAgentId(trimmed as any) ? (trimmed as AgentId) : undefined;
        })();
        const suggestedModelId =
            typeof suggestedModelIdRaw === 'string' && suggestedModelIdRaw.trim().length > 0
                ? (suggestedModelIdRaw.trim() as ModelMode)
                : undefined;

        const exampleToolCalls = Array.isArray(exampleToolCallsRaw)
            ? exampleToolCallsRaw.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
            : undefined;

        out.push({
            id: id.trim(),
            description,
            ...(typeof title === 'string' && title.trim().length > 0 ? { title: title.trim() } : {}),
            ...(typeof enabled === 'boolean' ? { enabled } : {}),
            ...(suggestedIntent ? { suggestedIntent } : {}),
            ...(suggestedBackendId ? { suggestedBackendId } : {}),
            ...(suggestedModelId ? { suggestedModelId } : {}),
            ...(exampleToolCalls && exampleToolCalls.length > 0 ? { exampleToolCalls } : {}),
        });
    }
    return out;
}

export function normalizeExecutionRunsGuidanceFingerprint(entry: ExecutionRunsGuidanceEntry): string {
    const description = normalizeWhitespace(entry.description).toLowerCase();
    const intent = entry.suggestedIntent ? entry.suggestedIntent.toLowerCase() : '';
    const backend = typeof entry.suggestedBackendId === 'string' ? entry.suggestedBackendId.trim().toLowerCase() : '';
    const model = typeof entry.suggestedModelId === 'string' ? entry.suggestedModelId.trim().toLowerCase() : '';
    return `${description}|${intent}|${backend}|${model}`;
}

export function buildExecutionRunsGuidanceBlock(params: Readonly<{
    entries: readonly ExecutionRunsGuidanceEntry[];
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
    const unique: ExecutionRunsGuidanceEntry[] = [];
    for (const entry of enabled) {
        const fingerprint = normalizeExecutionRunsGuidanceFingerprint(entry);
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
    let included = 0;
    const includedEntries: ExecutionRunsGuidanceEntry[] = [];

    for (const entry of unique) {
        const label = typeof entry.title === 'string' && entry.title.trim().length > 0 ? `${entry.title.trim()}: ` : '';
        const hints: string[] = [];
        if (entry.suggestedIntent) hints.push(`intent=${entry.suggestedIntent}`);
        if (entry.suggestedBackendId) hints.push(`backend=${entry.suggestedBackendId}`);
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
        lines.push(`- (+${remaining} more rules in settings)`);
    }

    const tryPush = (line: string): boolean => {
        const nextLen = usedChars + 1 + line.length;
        if (nextLen > maxChars) return false;
        lines.push(line);
        usedChars = nextLen;
        return true;
    };

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

    // Best-effort: include explicit delegation mechanics so the agent knows how to act on the rules.
    // Skip if it doesn't fit the character budget.
    const delegationLines = [
        '',
        '## Delegating via MCP',
        'When you decide to delegate work to an execution run, use the MCP tools available to you:',
        '- Start a run with `execution_run_start` (include the task prompt; optionally pass intent/backend/model from the rules above).',
        '- Poll or fetch results with `execution_run_get` (or list runs with `execution_run_list`).',
        '- Stop a run with `execution_run_stop` if it is no longer needed.',
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
