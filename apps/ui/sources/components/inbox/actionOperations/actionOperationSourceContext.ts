import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import type { SessionListHomeObservation } from '@/sync/domains/session/listing/sessionListHomeObservation';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    buildSessionContextFacts,
    projectSessionContextPresentation,
} from '@/sync/domains/session/presentation/sessionContextPresentation';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { readSessionRecordingVisibility } from '@/sync/store/sessionRecordingVisibility';
import type { SessionRecordingVisibility } from '@/sync/domains/session/listing/recordingPrivacy';

export type ActionOperationSourceContext = Readonly<{
    address: SessionAddress | null;
    sessionTitle: string | null;
    machineTitle: string | null;
    contextLine: string | null;
    accessibilityContext: string | null;
}>;

/**
 * One presentation owner for the Home-qualified source of an Action operation.
 *
 * A wire-v1 operation has no Home field. Callers may supply only the Home captured by the
 * authenticated socket/RPC boundary. Missing evidence stays unqualified: this projector never
 * consults the active Home and never adopts a same-ID Session or Machine from another Home.
 */
export function projectActionOperationSourceContext(params: Readonly<{
    serverId: string | null;
    snapshot: ActionOperationSnapshotV1;
    session: SessionListRenderableSession | null;
    machine: Machine | null;
    /**
     * The managed guest's name when the operation concerns one. Such an operation runs on its controller, so
     * `machine` is the controller; the guest is who it is about.
     */
    managedMachineName?: string | null;
    serverProfile: ServerProfile | null;
    audienceScope?: ServerAccountScope | null;
    /**
     * The exact Home's raw list observation from the canonical per-Home list/currentness owner.
     * An Action operation retained from a secondary Home reads the same Offline/last-updated fact
     * Session rows and approval cards already show; omitting it leaves currentness unknown rather
     * than assumed current (Lane 07.4 §2, §12).
     */
    homeObservation?: SessionListHomeObservation | null;
    nowMs?: number;
    isRecordingVisible?: SessionRecordingVisibility;
}>): ActionOperationSourceContext {
    const address = normalizeSessionAddress(params.serverId, params.snapshot.scope.sessionId);
    if (!params.serverId) {
        return {
            address: null,
            sessionTitle: null,
            machineTitle: null,
            contextLine: null,
            accessibilityContext: null,
        };
    }

    const machineTitle = params.managedMachineName || getMachineDisplayName(params.machine);
    if (!address) {
        const homeName = resolveHomeDisplayName(params.serverProfile);
        return {
            address: null,
            sessionTitle: null,
            machineTitle,
            contextLine: homeName,
            accessibilityContext: homeName,
        };
    }

    const session = (params.isRecordingVisible ?? readSessionRecordingVisibility())(address) ? params.session : null;
    const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
    const nowMs = params.nowMs ?? Date.now();
    const context = projectSessionContextPresentation(buildSessionContextFacts({
        address,
        serverProfile: params.serverProfile,
        awareness: session ? projectUiSessionAwareness(session, nowMs) : null,
        viewer: session?.viewer,
        audienceContext: session?.access?.audienceContext,
        audienceScope: params.audienceScope,
        homeDir: ownerMetadata?.homeDir ?? null,
        homeObservation: params.homeObservation ?? null,
        nowMs,
    }));
    return {
        address,
        sessionTitle: session && context.mayShowDecryptedContent === true ? getSessionName(session, address.serverId) : null,
        machineTitle,
        contextLine: context.contextLine,
        accessibilityContext: context.accessibilityContext,
    };
}
