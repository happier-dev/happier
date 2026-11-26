import { FileChangesScopeSchema, type FileChangesScope } from '@happier-dev/protocol/scm';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

export function fileChangesScopeOfComparison(comparison: unknown): FileChangesScope | null {
    if (!comparison || typeof comparison !== 'object' || Array.isArray(comparison)) return null;
    const source = comparison as Record<string, unknown>;
    if (source.kind === 'turnCheckpoint') return readFileChangesScope({ kind: 'turn', turnId: source.turnId });
    return source.kind === 'session' || source.kind === 'workingTree' ? readFileChangesScope(source) : null;
}

export function fileChangesComparisonOfScope(scope: FileChangesScope): SessionScmReviewComparison {
    return scope.kind === 'turn' ? { kind: 'turnCheckpoint', turnId: scope.turnId } : { kind: scope.kind };
}

/** Tolerant persisted-state reader; Action input admission remains strict at its schema. */
export function readFileChangesScope(value: unknown): FileChangesScope | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const parsed = FileChangesScopeSchema.safeParse(record.kind === 'turn'
        ? { kind: record.kind, turnId: record.turnId } : { kind: record.kind });
    return parsed.success ? parsed.data : null;
}

/** One selection policy for UI scope, live-diff admission and captured evidence. */
export function resolveFileChangesScope(input: Readonly<{
    storedScope?: unknown;
    initialChanges?: SessionScmReviewComparison;
    sessionId?: string | null;
    latestTurnId?: string | null;
    readOnly?: boolean;
}>) {
    const current = (input.readOnly ? null : readFileChangesScope(input.storedScope)) ?? fileChangesScopeOfComparison(input.initialChanges)
        ?? (input.sessionId ? { kind: 'session' as const } : { kind: 'workingTree' as const });
    const openingScope = fileChangesScopeOfComparison(input.initialChanges);
    const selector = input.readOnly && input.initialChanges ? input.initialChanges : openingScope && JSON.stringify(openingScope) === JSON.stringify(current)
        ? input.initialChanges! : fileChangesComparisonOfScope(current);
    const turnId = current.kind === 'turn' ? current.turnId
        : openingScope?.kind === 'turn' ? openingScope.turnId : input.latestTurnId ?? null;
    const capture = current.kind !== 'workingTree' || Boolean(selector.comparisonId);
    return { current, selector, capture, readOnly: input.readOnly === true || (current.kind === 'workingTree' && capture), turnId };
}
