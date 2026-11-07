/** Follow-status admission diagnostics contain identity and generation, never metadata content. */
export class ExternalSessionFollowMetadataMismatchError extends Error {
    constructor(
        readonly code: 'external_session_follow_linked_metadata_mismatch' | 'external_session_follow_generation_mismatch',
        readonly details: Readonly<{
            sessionId?: string;
            expectedLinkGeneration: number | null;
            actualLinkGeneration: number | null;
        }>,
    ) {
        super('linked_session_identity_mismatch');
    }
}
