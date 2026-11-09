import type { ProviderBoundModelRef} from '@happier-dev/protocol/providers/selection/v1';
import type { SessionSpawnNewInitialInputDispositionV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

import type { PermissionMode } from '@/constants/PermissionModes';
import type { StrictSessionSpawnNewInput } from '@/sync/ops/actions/sessionSpawnNewAction';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { NewSessionCreationProfile } from '@/components/sessions/new/navigation/newSessionHost';

/**
 * The first Send of an embedded new chat: exactly the create input the incumbent New Session flow
 * would have spawned (agent target, model selection, permission mode, managed directory, first
 * message and attachments), not a new schema. The presentation host binds what its grant decides
 * (machine, placement) before it spawns.
 */
export type EmbeddedNewSessionDraft = StrictSessionSpawnNewInput;

/**
 * What the presentation host's spawn settled. `initialInput` is the spawn's own disposition of the
 * first message; absent means the host spawned without it, and the incumbent flow's afterCreated
 * sender admits the prepared first turn before handing off to the Session.
 */
export type EmbeddedNewSessionCreated = Readonly<{
    sessionId: string;
    initialInput?: SessionSpawnNewInitialInputDispositionV1;
}>;

export type EmbeddedSessionNewChatCreation = Readonly<{
    /** Stable identity of this admitted new-chat intent, supplied by its presentation host. */
    draftId: string;
    /** Authenticated by the frame's credential owner; never supplied by plugin authors. */
    draftScope?: ServerAccountScope;
    machineId?: string;
    /** Default `null` = no extra narrowing (same hide-key mapping as the embedded arm). */
    allowedModels?: readonly ProviderBoundModelRef[] | null;
    /** Supplied by the admitted creation host, not synthesized from its model grant. */
    modelCatalog?: NewSessionCreationProfile['modelCatalog'];
    /** A fixed agent: the agent picker is hidden. */
    agentTargetKey?: string;
    /** Coerced to the first allowed mode when the remembered or default one is not listed. */
    permissionModes?: readonly PermissionMode[] | null;
    /** Default `true`. */
    attachments?: boolean;
}>;

export type EmbeddedSessionNewChatTarget = Readonly<{
    kind: 'new';
    creation: EmbeddedSessionNewChatCreation;
    /**
     * Supplied by the presentation host; spawns and returns the new Session id. `attemptId` is
     * `useCreateNewSession`'s launch-attempt identity: stable across Retry of one user intent, so
     * the executor passes it as the spawn request identity and a retried spawn is idempotent.
     */
    onCreate(
        draft: EmbeddedNewSessionDraft,
        attempt: Readonly<{ attemptId: string }>,
    ): Promise<EmbeddedNewSessionCreated>;
    /** Commits route presentation only after the incumbent post-create follow-up settles. */
    onPresented(sessionId: string): void;
}>;

/**
 * What an embedded Session controller presents: an existing Session, or — for a presentation host
 * that may start one (the embed route, R-CREATE) — the app's real new-session composer whose first
 * Send creates it.
 */
export type EmbeddedSessionTarget =
    | Readonly<{ kind: 'session'; sessionId: string }>
    | EmbeddedSessionNewChatTarget;
