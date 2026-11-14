import type { TeamGroupNameProjectionV1, TeamGroupV1 } from '@happier-dev/protocol/teams';
import type {
    PrivateLabelReadPolicyV1,
    PrivateLabelStoredV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';

import { createPrivateLabelClient } from '@/sync/ops/privateLabels/privateLabelClient';

type PrivateLabelOpener = Pick<ReturnType<typeof createPrivateLabelClient>, 'open'>;
type PrivateLabelSealer = Pick<ReturnType<typeof createPrivateLabelClient>, 'seal'>;

// A Group's admitted stored arm, not the viewing Account's current mode,
// decides whether a recipient projection may be opened.
const TEAM_GROUP_LABEL_READ_POLICY = { kind: 'team-resource' } as const satisfies PrivateLabelReadPolicyV1;

/** The immutable cipher binding for a Team Group's human-readable name. */
export function teamGroupNameBinding(groupId: string) {
    return { entity: 'team_group', field: 'name', id: groupId } as const;
}

/**
 * Opens exactly the recipient-safe Group projection through the one private-label
 * client. Callers receive no fallback text when the reader has no valid envelope.
 */
export async function openTeamGroupName(params: Readonly<{
    client: PrivateLabelOpener;
    group: TeamGroupV1;
    signal?: AbortSignal;
}>): Promise<string | null> {
    return await openTeamGroupNameProjection({
        client: params.client,
        groupId: params.group.id,
        name: params.group.name,
        signal: params.signal,
    });
}

/** Opens any authorized Group-name projection through the one label client. */
export async function openTeamGroupNameProjection(params: Readonly<{
    client: PrivateLabelOpener;
    groupId: string;
    name: TeamGroupNameProjectionV1;
    signal?: AbortSignal;
}>): Promise<string | null> {
    if (params.name.kind !== 'available') return null;
    return await params.client.open({
        binding: teamGroupNameBinding(params.groupId),
        label: params.name.label,
        readPolicy: TEAM_GROUP_LABEL_READ_POLICY,
        signal: params.signal,
    });
}

/** Seals one human-authored Group label through the canonical census owner. */
export async function sealTeamGroupName(params: Readonly<{
    client: PrivateLabelSealer;
    teamId: string;
    groupId: string;
    value: string;
    signal?: AbortSignal;
}>): Promise<PrivateLabelStoredV1 | null> {
    return await params.client.seal({
        owner: { kind: 'team', teamId: params.teamId },
        binding: teamGroupNameBinding(params.groupId),
        value: params.value,
        signal: params.signal,
    });
}
