import type { SessionScopedSocketBinding } from "@/app/api/socket/sessionScopedBinding";
import type { SocketClientType } from "@/app/api/socketRooms";
import type { SessionPublisherAuthorityProjectionV1 } from "@/app/presence/sessionPublisherPresence";
import type { AuthTokenAuthenticationEvidenceV1 } from "@happier-dev/protocol";
import type { SessionHumanPresencePendingMessageEditV1 } from "@happier-dev/protocol/sessions";

declare module "socket.io" {
    interface SocketData {
        userId?: string;
        clientType?: SocketClientType;
        clientPurpose?: string;
        sessionId?: string;
        machineId?: string;
        /** Set only by machine Socket authentication after persisted proof verification. */
        verifiedMachineInstallationId?: string;
        sessionScopedBinding?: SessionScopedSocketBinding;
        sessionPublisherAuthority?: SessionPublisherAuthorityProjectionV1;
        /** Replaced after the post-connect currentness check; exact to this socket credential. */
        authAuthority?: "present_user" | "account_automation";
        authTokenAuthenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[];
        humanPresenceTypingSessionId?: string;
        humanPresenceTypingDiscussionId?: string;
        humanPresenceTypingExpiresAt?: number;
        /** Actual Session visibility; presence rooms also contain editors and queue observers. */
        humanPresenceVisibleSessionIds?: readonly string[];
        /** Admitted edits live with this socket; queue observers declare an empty array. */
        humanPresencePendingMessageEdits?: readonly SessionHumanPresencePendingMessageEditV1[];
    }
}

export {};
