import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/protocol/plugins/ui';

/**
 * One-shot unresolved placement input for an exact New Session draft.
 *
 * A candidate is not a selected server, machine, or directory, so it cannot
 * be persisted as though the reader had chosen it. This bridge only survives
 * the navigation from the host selector to the mounted New Session screen;
 * that screen reuses its incumbent route/draft selection owner to commit the
 * reader's actual choice. It is not a project registry or a second placement
 * owner.
 */
export type NewSessionComposerPlacementSeedV1 = Readonly<{
    candidates?: readonly PluginUiSessionPlacementCandidateV1[];
}>;

const seedsByDraftId = new Map<string, NewSessionComposerPlacementSeedV1>();

function normalizeDraftId(draftId: string | null | undefined): string | null {
    if (typeof draftId !== 'string') return null;
    const trimmed = draftId.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function writeNewSessionComposerPlacementSeeds(
    draftId: string | null | undefined,
    seed: NewSessionComposerPlacementSeedV1,
): void {
    const key = normalizeDraftId(draftId);
    if (!key) return;
    const candidates = seed.candidates ?? [];
    if (candidates.length === 0) {
        seedsByDraftId.delete(key);
        return;
    }
    seedsByDraftId.set(key, Object.freeze({
        candidates: Object.freeze([...candidates]),
    }));
}

export function readNewSessionComposerPlacementSeeds(
    draftId: string | null | undefined,
): NewSessionComposerPlacementSeedV1 | null {
    const key = normalizeDraftId(draftId);
    return key === null ? null : seedsByDraftId.get(key) ?? null;
}

export function clearNewSessionComposerPlacementSeeds(
    draftId: string | null | undefined,
): void {
    const key = normalizeDraftId(draftId);
    if (key !== null) seedsByDraftId.delete(key);
}

export function clearAllNewSessionComposerPlacementSeeds(): void {
    seedsByDraftId.clear();
}
