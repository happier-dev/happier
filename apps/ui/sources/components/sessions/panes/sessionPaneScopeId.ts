/**
 * The ONE spelling of a session's pane scope id.
 *
 * A pane scope is addressable from anywhere in the app by this string — that is what lets a
 * transcript row, a header button and a popover anchored to the composer all reach the same
 * session's panes without being hosted by one. It was being re-spelled inline at every one of those
 * call sites, which is a split-brain waiting for the day the prefix changes.
 */
export function resolveSessionPaneScopeId(sessionId: string): string {
    return `session:${sessionId}`;
}
