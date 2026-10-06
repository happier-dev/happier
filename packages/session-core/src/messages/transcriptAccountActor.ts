import { SessionMessageAccountActorV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import type { SessionMessageAccountActorV1 } from '@happier-dev/protocol';

/** Account identity is local to the Home that supplied this message. */
export type TranscriptAccountActor = SessionMessageAccountActorV1 & Readonly<{ serverId: string }>;

export type TranscriptAccountActorMetadata = {
    accountActor?: TranscriptAccountActor | null;
};

export function qualifyTranscriptAccountActor(
    actor: SessionMessageAccountActorV1 | null | undefined,
    serverId: string | null | undefined,
): TranscriptAccountActor | null | undefined {
    if (actor === undefined) return undefined;
    return actor && serverId ? { ...actor, serverId } : null;
}

export function readTranscriptAccountActorMetadata(
    value: unknown,
    serverId: string | null | undefined,
): TranscriptAccountActorMetadata {
    if (value === null) return { accountActor: null };
    const parsed = SessionMessageAccountActorV1Schema.safeParse(value);
    return parsed.success ? { accountActor: qualifyTranscriptAccountActor(parsed.data, serverId) } : {};
}

/** Omission is not a retraction; profile refreshes do not change durable content. */
export function applyTranscriptAccountActorMetadata(
    target: TranscriptAccountActorMetadata,
    source: TranscriptAccountActorMetadata | undefined,
): boolean {
    const next = source?.accountActor;
    if (next === undefined) return false;
    const previous = target.accountActor;
    if (previous === next) return false;
    if (previous && next
        && previous.v === next.v
        && previous.serverId === next.serverId
        && previous.accountId === next.accountId
        && (previous.profile === next.profile || (previous.profile && next.profile
            && previous.profile.firstName === next.profile.firstName
            && previous.profile.lastName === next.profile.lastName
            && previous.profile.username === next.profile.username
            && previous.profile.avatarUrl === next.profile.avatarUrl))) return false;
    target.accountActor = next;
    return true;
}
