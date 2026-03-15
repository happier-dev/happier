import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

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
}>;
