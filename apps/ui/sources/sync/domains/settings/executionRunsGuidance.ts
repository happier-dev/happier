import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';

import {
    readBackendTargetRefV2,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

type ExecutionRunsGuidanceIntent = 'review' | 'plan' | 'delegate';

export type ExecutionRunsGuidanceEntry = Readonly<{
    id: string;
    title?: string;
    description: string;
    enabled?: boolean;
    suggestedIntent?: ExecutionRunsGuidanceIntent;
    suggestedBackendTarget?: BackendTargetRefV2;
    suggestedModelId?: ModelMode;
    exampleToolCalls?: readonly string[];
}>;

function normalizeWhitespace(value: string): string {
    return value.trim().replace(/\s+/g, ' ');
}

function normalizeOptionalNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseIntent(raw: unknown): ExecutionRunsGuidanceIntent | undefined {
    const v = normalizeOptionalNonEmptyString(raw);
    if (v === 'review' || v === 'plan' || v === 'delegate') return v;
    return undefined;
}

function parseBackendTarget(raw: unknown): BackendTargetRefV2 | undefined {
    try {
        return readBackendTargetRefV2(raw as BackendTargetRefV2Input);
    } catch {
        return undefined;
    }
}

function parseExampleToolCalls(raw: unknown): readonly string[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const lines = raw
        .filter((v) => typeof v === 'string')
        .map((v) => v.trim())
        .filter(Boolean);
    return lines.length > 0 ? lines : undefined;
}

export function coerceExecutionRunsGuidanceEntries(raw: unknown): ExecutionRunsGuidanceEntry[] {
    if (!Array.isArray(raw)) return [];
    const out: ExecutionRunsGuidanceEntry[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

        const id = normalizeOptionalNonEmptyString((item as any).id);
        const description = normalizeOptionalNonEmptyString((item as any).description);
        if (!id || !description) continue;

        const title = normalizeOptionalNonEmptyString((item as any).title);
        const enabled = typeof (item as any).enabled === 'boolean' ? (item as any).enabled : undefined;
        const suggestedIntent = parseIntent((item as any).suggestedIntent);
        const suggestedBackendTarget = parseBackendTarget((item as any).suggestedBackendTarget);
        const suggestedModelIdRaw = normalizeOptionalNonEmptyString((item as any).suggestedModelId);
        const suggestedModelId = suggestedModelIdRaw ? (suggestedModelIdRaw as ModelMode) : undefined;
        const exampleToolCalls = parseExampleToolCalls((item as any).exampleToolCalls);

        out.push({
            id,
            description,
            ...(title ? { title } : {}),
            ...(enabled !== undefined ? { enabled } : {}),
            ...(suggestedIntent ? { suggestedIntent } : {}),
            ...(suggestedBackendTarget ? { suggestedBackendTarget } : {}),
            ...(suggestedModelId ? { suggestedModelId } : {}),
            ...(exampleToolCalls ? { exampleToolCalls } : {}),
        });
    }
    return out;
}

export function normalizeExecutionRunsGuidanceFingerprint(entry: ExecutionRunsGuidanceEntry): string {
    const description = normalizeWhitespace(entry.description).toLowerCase();
    const intent = entry.suggestedIntent ? entry.suggestedIntent.toLowerCase() : '';
    const backend = entry.suggestedBackendTarget ? resolveBackendTargetKeyV2(entry.suggestedBackendTarget).toLowerCase() : '';
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
    const tryPush = (line: string): boolean => {
        const nextLen = usedChars + 1 + line.length;
        if (nextLen > maxChars) return false;
        lines.push(line);
        usedChars = nextLen;
        return true;
    };

    let included = 0;
    for (const entry of unique) {
        const label = typeof entry.title === 'string' && entry.title.trim().length > 0 ? `${entry.title.trim()}: ` : '';
        const hints: string[] = [];
        if (entry.suggestedIntent) hints.push(`intent=${entry.suggestedIntent}`);
        if (entry.suggestedBackendTarget) hints.push(`backend=${resolveBackendTargetKeyV2(entry.suggestedBackendTarget)}`);
        if (entry.suggestedModelId) hints.push(`model=${entry.suggestedModelId}`);

        if (!tryPush(`- ${label}${entry.description.trim()}`)) break;
        if (hints.length > 0 && !tryPush(`  - hints: ${hints.join(', ')}`)) break;

        if (Array.isArray(entry.exampleToolCalls) && entry.exampleToolCalls.length > 0) {
            if (!tryPush('  - exampleToolCalls:')) break;
            for (const toolCall of entry.exampleToolCalls) {
                if (!tryPush(`    - ${String(toolCall).trim()}`)) break;
            }
        }

        included += 1;
        if (!tryPush('')) break;
    }

    const remaining = Math.max(0, unique.length - included);
    const text = lines.join('\n').trimEnd();
    return { text, includedCount: included, remainingCount: remaining };
}
