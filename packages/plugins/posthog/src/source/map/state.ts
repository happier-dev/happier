/**
 * Native status mapping.
 *
 * The provider declares an issue row's `status` as a bare string rather than an enum,
 * so an unrecognized value is expected rather than exceptional. `pending_release` and
 * anything unrecognized map to the neutral `unknown` presentation, which is a shared
 * canonical arm — not a PostHog-local string, field fallback, or new carrier — and the
 * native label always stays visible alongside it.
 *
 * `suppressed` is retained as itself. It is not a generic "ignored": suppressing an
 * issue drops future matching exceptions at ingest, so laundering it into a reversible
 * status would misrepresent data loss. `all` is a filter value and is never a row state.
 */

/** The presentation arms this source can emit. `unknown` is the shared neutral arm. */
export type PosthogPresentationState =
    | 'active'
    | 'resolved'
    | 'suppressed'
    | 'closed'
    | 'unknown';

export type PosthogMappedState = Readonly<{
    presentation: PosthogPresentationState;
    /** Always preserved so the provider's own word stays visible. */
    nativeLabel: string;
}>;

export function mapPosthogIssueState(nativeStatus: string): PosthogMappedState {
    switch (nativeStatus) {
        case 'active':
            return { presentation: 'active', nativeLabel: nativeStatus };
        case 'resolved':
            return { presentation: 'resolved', nativeLabel: nativeStatus };
        case 'suppressed':
            return { presentation: 'suppressed', nativeLabel: nativeStatus };
        case 'archived':
            return { presentation: 'closed', nativeLabel: nativeStatus };
        default:
            // `pending_release` and every future or unrecognized provider value.
            return { presentation: 'unknown', nativeLabel: nativeStatus };
    }
}
