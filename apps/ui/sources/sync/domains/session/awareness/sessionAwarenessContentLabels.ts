import type { SessionAwarenessEncryptionV1 } from '@happier-dev/protocol/sessions/awareness/projectionV1';
import { t } from '@/text';

/**
 * The one copy owner for "this viewer cannot read the content, and why".
 *
 * Row status text and the shared context line both explain the same encryption answer, so they
 * read it here instead of each keeping a switch that can drift. `null` means there is nothing
 * truthful to say: readable content needs no explanation, and an unobserved envelope is unknown
 * rather than "preparing" — a caller that wants a fallback word supplies its own.
 */
export function resolveSessionAwarenessContentLabel(
    encryption: SessionAwarenessEncryptionV1,
): string | null {
    switch (encryption) {
        case 'locked': return t('status.encryptedUnavailable');
        case 'preparing': return t('status.encryptedPreparing');
        case 'repair_needed': return t('status.encryptedRepairNeeded');
        case 'access_pending': return t('session.access.pending');
        case 'setup_required': return t('session.access.setup');
        case 'content_unavailable': return t('session.access.unavailable');
        case 'plain':
        case 'ready':
        case 'unknown':
            return null;
    }
}
