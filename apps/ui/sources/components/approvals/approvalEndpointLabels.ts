import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { formatPathRelativeToHome } from '@/utils/sessions/sessionUtils';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';
import { readDisplayPathForSession } from '@/sync/ops/sessionMachineTarget';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

/**
 * A machine plus workspace location, already resolved to what a person should
 * read. Approval surfaces show these facts through `SessionContextChips`.
 */
export type ApprovalEndpointLabels = {
    machineLabel: string | null;
    pathLabel: string | null;
};

/** Where a session currently runs, as the canonical session/machine state describes it. */
export function readApprovalSessionEndpointLabels(input: Readonly<{
    session: Session | SessionListRenderableSession | null;
    machine: Machine | null;
    machineId?: string | null;
}>): ApprovalEndpointLabels {
    const ownerMetadata = input.session ? readSessionOwnerMetadataView(input.session) : null;
    // A no-folder session names only its machine; its private folder is not a destination to show.
    const displayPath = input.session && readSessionDirectoryKind(ownerMetadata) !== 'managed'
        ? readDisplayPathForSession({ sessionId: null, metadata: ownerMetadata })
        : '';

    return {
        machineLabel: getMachineDisplayName(input.machine) ?? input.machineId ?? null,
        pathLabel: displayPath ? formatSessionPath(displayPath, ownerMetadata?.homeDir) : null,
    };
}

/**
 * A destination the daemon already canonicalized. The machine record supplies
 * the human name and home directory when the account knows the machine; the
 * identifiers the proof carries remain the truthful fallback.
 */
export function readApprovalTargetEndpointLabels(input: Readonly<{
    machineId: string;
    machine: Machine | null;
    canonicalRoot: string;
}>): ApprovalEndpointLabels {
    return {
        machineLabel: getMachineDisplayName(input.machine) ?? input.machineId,
        pathLabel: formatPathRelativeToHome(input.canonicalRoot, input.machine?.metadata?.homeDir ?? undefined),
    };
}
