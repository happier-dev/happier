import type { TranscriptJumpScope } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';

/**
 * A TRANSCRIPT, opened as a details tab — the host an imported workflow-agent sidechain was missing.
 *
 * Every details host in the app anchors on something local: a `SessionSubagent`, or the tool message
 * that owns a sidechain. An imported workflow-agent sidecar has neither, so it could be previewed in
 * place and nowhere else. Manufacturing a tool call or a subagent to satisfy an existing host would
 * put fabricated data into a real model to make a view happy, so the host is a new resource kind
 * instead — the established extension point beside `file`, `commit`, `scmReview`, `scmStash`,
 * `terminal` and `subagent`.
 *
 * **The scope is `TranscriptJumpScope`, reused, not re-spelled.** The app already models
 * main-versus-sidechain there and the jump machinery already speaks it; a second spelling of the
 * same idea is exactly the split-brain this program exists to remove.
 *
 * **Discriminated, never `sidechainId?: string`.** With an optional field, `undefined` could mean
 * "the main transcript", "not loaded yet", or "a bug", and nothing in the type tells them apart. The
 * union makes those invalid states unrepresentable, which is why the guard below refuses a resource
 * whose scope is a bare object with an optional id.
 *
 * `sessionId` rides on the scope because a transcript is meaningless without one. The details panel
 * is session-scoped today and REJECTS a foreign one explicitly rather than rendering the wrong
 * thing; carrying the id is what makes that check possible instead of assumed.
 */
export type SessionTranscriptDetailsResource = Readonly<{
    kind: 'transcript';
    scope: TranscriptJumpScope;
    /** The agent's own title. Absent falls back at the tab, never to a blank tab label. */
    title?: string;
}>;

export type SessionTranscriptDetailsTab = Readonly<{
    key: string;
    kind: 'transcript';
    title: string;
    resource: SessionTranscriptDetailsResource;
}>;

/**
 * Whether an opaque details resource is a transcript one.
 *
 * Fail-closed like the rest of the family: a resource whose scope is not one of the two spellings
 * the union allows is refused rather than coerced, so a producer cannot open a tab that renders
 * nothing addressable.
 */
export function isSessionTranscriptDetailsResource(
    value: unknown,
): value is SessionTranscriptDetailsResource {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown; scope?: unknown };
    if (maybe.kind !== 'transcript') return false;
    return isTranscriptJumpScope(maybe.scope);
}

function isTranscriptJumpScope(value: unknown): value is TranscriptJumpScope {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown; sessionId?: unknown; sidechainId?: unknown };
    if (!isNonBlankString(maybe.sessionId)) return false;
    if (maybe.kind === 'main') return true;
    if (maybe.kind === 'sidechain') return isNonBlankString(maybe.sidechainId);
    return false;
}

function isNonBlankString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

/** The stable tab key for a scope, so re-opening the same transcript reuses its tab. */
export function resolveSessionTranscriptDetailsTabKey(scope: TranscriptJumpScope): string {
    return scope.kind === 'sidechain'
        ? `transcript:sidechain:${scope.sidechainId}`
        : `transcript:main:${scope.sessionId}`;
}
