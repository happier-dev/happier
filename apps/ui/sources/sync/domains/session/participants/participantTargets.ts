import type { ParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';

export type SessionParticipantTarget = Readonly<{
    key: string;
    /**
     * Optional provider/user supplied label. UI code is responsible for localizing any fallback labels.
     */
    displayLabel?: string;
    /**
     * Optional accent identifier used by UI to render a consistent recipient marker (e.g. team color).
     * Must be a stable name that the UI can map onto the active theme (no hardcoded hex values here).
     */
    accentName?: string;
    recipient: ParticipantRecipientV1;
    /**
     * The intent of the execution Run this target addresses, when known. A walkthrough generator
     * (`scm_diff_summary`) is answered by its own Run, so every composer drops the Session's controls for it.
     */
    runIntent?: string;
}>;
