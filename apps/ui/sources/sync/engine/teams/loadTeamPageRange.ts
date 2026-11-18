import type { HomeDomainFailure } from '@/sync/ops/teams/teamActionClient';

export type TeamPage<TRow> = Readonly<{
    items: readonly TRow[];
    nextCursor: string | null;
}>;

export type TeamPageOutcome<TRow> =
    | Readonly<{ kind: 'succeeded'; value: TeamPage<TRow> }>
    | Readonly<{ kind: 'failed'; failure: HomeDomainFailure }>;

/**
 * Revalidates the loaded range from the Home's first page through fresh cursors.
 * Only a complete range is returned for publication; a later-page refusal is
 * returned unchanged so each lifetime's existing owner retains or withdraws its
 * snapshot. Reaching the end can shrink the range after rows were removed.
 */
export async function loadTeamPageRange<TRow>(params: Readonly<{
    loadedRowCount: number;
    loadPage: (cursor: string | null) => Promise<TeamPageOutcome<TRow> | null>;
    isCancelled?: () => boolean;
}>): Promise<TeamPageOutcome<TRow> | null> {
    const items: TRow[] = [];
    let cursor: string | null = null;
    while (true) {
        const outcome = await params.loadPage(cursor);
        if (outcome === null || params.isCancelled?.()) return null;
        if (outcome.kind === 'failed') return outcome;
        items.push(...outcome.value.items);
        cursor = outcome.value.nextCursor;
        if (items.length >= params.loadedRowCount || cursor === null) {
            return { kind: 'succeeded', value: { items, nextCursor: cursor } };
        }
    }
}
