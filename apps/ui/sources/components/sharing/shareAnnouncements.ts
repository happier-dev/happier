import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { t } from '@/text';
import { sharePrincipalKey } from './sharePrincipalPresentation';
import type { SharePrincipalPresentation } from './shareSheetTypes';

/** Call only after the audience owner acknowledges the write, including when its editor closes. */
export function announceShareGrantRemovals(previous: readonly SharePrincipalPresentation[], next: readonly PrincipalRefV1[]): void {
    const retained = new Set(next.map(sharePrincipalKey));
    for (const principal of previous) {
        if (!retained.has(principal.key)) {
            announceAccessibilityMessage(t('shareSheet.removedAnnouncement', { name: principal.displayName }));
        }
    }
}
