import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import type { SessionSubagentAutoRecipientContext } from '@/sync/domains/session/subagents/autoRecipient/types';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { Session } from '@/sync/domains/state/storageTypes';

export type ProviderParticipantSnapshot = Readonly<Record<string, unknown>>;

export type SessionProviderParticipantBehavior = Readonly<{
    deriveSnapshot?: (ctx: Readonly<{
        flavor: string | null;
        messages: readonly Message[];
    }>) => ProviderParticipantSnapshot | null;
    deriveSidechainIds?: (ctx: Readonly<{
        flavor: string | null;
        messages: readonly Message[];
    }>) => readonly string[];
    deriveTargets?: (ctx: Readonly<{
        session: Session;
        messages: readonly Message[];
        currentTargets: readonly SessionParticipantTarget[];
    }>) => readonly SessionParticipantTarget[];
}>;

export type SessionProviderSubagentBehavior = Readonly<{
    deriveSubagents?: (ctx: Readonly<{
        flavor: string | null;
        messages: readonly Message[];
    }>) => readonly SessionSubagent[];
    /**
     * This line is provider bookkeeping and must never be shown as activity.
     *
     * A fact about the TEXT, deliberately: every surface that shows "the newest useful line" for a
     * sidechain asks this — the roster row, and the expanded body under it, which is loaded by
     * sidechain id and has no subagent to describe. Taking a subagent here would make the rule
     * unanswerable for exactly the rows that most need it, and the two surfaces would disagree
     * about the same sidechain.
     */
    shouldIgnoreActivityPreviewText?: (ctx: Readonly<{
        text: string;
    }>) => boolean;
    resolveAutoRecipient?: (ctx: SessionSubagentAutoRecipientContext) => ParticipantRecipientV1 | null;
}>;

export type SessionProviderBehavior = Readonly<{
    participants?: SessionProviderParticipantBehavior;
    subagents?: SessionProviderSubagentBehavior;
}>;
