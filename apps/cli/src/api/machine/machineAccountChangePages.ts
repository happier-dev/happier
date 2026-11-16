import {
    projectPushedChangesPageAt,
    PushedAccountChangesPageV1Schema,
    type ChangeKind,
    type ChangesResponse,
    type PushedAccountChangesPageV1,
} from '@happier-dev/protocol/changes';

// Every domain consumed by Machine catch-up, including share revisions.
// Selection belongs in the shared feed query (read or pushed), before transport decoding.
export const MACHINE_ACCOUNT_CHANGE_KINDS = [
    'account', 'automation', 'artifact', 'discussion', 'machine', 'machineRecipientAccess',
    'pluginDomain', 'savedSecretResource', 'session', 'share',
] as const satisfies readonly ChangeKind[];

/** A pushed page held until the feed owner applies it, scoped to the socket that received it. */
export type QueuedPushedChangesPage = Readonly<{ transportGeneration: number; pushed: PushedAccountChangesPageV1 }>;

/** The wake's pushed page, parsed explicitly; malformed is null and the wake reads the feed. */
export function readPushedChangesPage(body: unknown): PushedAccountChangesPageV1 | null | undefined {
    if (!body || typeof body !== 'object' || !('rows' in body)) return undefined;
    const parsed = PushedAccountChangesPageV1Schema.safeParse((body as { rows: unknown }).rows);
    return parsed.success ? parsed.data : null;
}

function usable(entry: QueuedPushedChangesPage, cursor: number, transportGeneration: number): boolean {
    return entry.transportGeneration === transportGeneration
        && entry.pushed.after <= cursor && cursor < entry.pushed.page.nextCursor;
}

export function hasUsablePushedChangesPage(queue: readonly QueuedPushedChangesPage[], cursor: number, transportGeneration: number): boolean {
    return queue.some(entry => usable(entry, cursor, transportGeneration));
}

/**
 * The pushed page a consumer at `cursor` applies (`projectPushedChangesPageAt`), or null for a gap
 * the feed read covers. Pages this cursor already covers and pages of another transport are dropped.
 */
export function takePushedChangesPage(
    queue: QueuedPushedChangesPage[], cursor: number, transportGeneration: number,
): Readonly<{ page: ChangesResponse; full: boolean }> | null {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
        const entry = queue[index]!;
        if (entry.transportGeneration !== transportGeneration || entry.pushed.page.nextCursor <= cursor) queue.splice(index, 1);
    }
    const index = queue.findIndex(entry => usable(entry, cursor, transportGeneration));
    if (index < 0) return null;
    const [{ pushed }] = queue.splice(index, 1) as [QueuedPushedChangesPage];
    return projectPushedChangesPageAt(pushed, cursor);
}
