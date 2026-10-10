import { isStoredContentPublicShareActiveV1 } from '@happier-dev/protocol/sharing/storedContentPublicShareV1';

/**
 * An existing public link remains a publication until it expires or is deleted.
 * A use limit governs new viewer admission, not already-issued message tokens.
 * Keep this lifetime rule shared by public reads and Session-context admission.
 */
export function isPublicSessionShareActive(
    publication: Readonly<{ expiresAt: Date | null }> | null,
    now: Date = new Date(),
): boolean {
    return isStoredContentPublicShareActiveV1(publication === null ? null : { expiresAt: publication.expiresAt?.getTime() ?? null }, now.getTime());
}
