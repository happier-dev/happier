import { getCurrentReleaseEntry } from './manifestRuntime';
import { getLastSeenReleaseId } from './storage';
import type { ReleaseNotesRelease } from './types';

export type ReleaseNotesLaunchOutcome =
    | Readonly<{ kind: 'open-story'; release: ReleaseNotesRelease }>
    | Readonly<{ kind: 'none' }>;

/**
 * Decide whether to open the release-notes story surface.
 *
 * Caller is responsible for:
 *   - waiting for setup/auth redirects to resolve
 *   - waiting for onboarding showcase gating
 *   - feature flag gating (`app.ui.releaseNotes`)
 */
export function resolveReleaseNotesLaunchOutcome(): ReleaseNotesLaunchOutcome {
    const release = getCurrentReleaseEntry();
    if (!release || release.cards.length === 0) {
        return { kind: 'none' };
    }
    const seen = getLastSeenReleaseId();
    if (seen === release.releaseId) {
        return { kind: 'none' };
    }
    return { kind: 'open-story', release };
}
