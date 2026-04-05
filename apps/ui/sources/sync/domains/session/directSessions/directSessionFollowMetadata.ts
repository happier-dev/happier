import {
    buildDirectSessionFollowPolicyV1,
    readDirectSessionFollowPolicyV1,
    type DirectSessionFollowPolicy,
} from '@happier-dev/protocol';

import type { Metadata } from '@/sync/domains/state/storageTypes';

import { readDirectSessionLink } from './readDirectSessionLink';

export type { DirectSessionFollowPolicy } from '@happier-dev/protocol';

export function readDirectSessionFollowPolicy(metadata: Metadata | null | undefined): DirectSessionFollowPolicy {
    const directSession = readDirectSessionLink(metadata);
    return readDirectSessionFollowPolicyV1(directSession?.followPolicyV1)?.policy ?? 'attached_only';
}

export function updateMetadataWithDirectSessionFollowPolicy(
    metadata: Metadata,
    params: Readonly<{
        policy: DirectSessionFollowPolicy;
        updatedAtMs?: number;
    }>,
): Metadata {
    const directSession = readDirectSessionLink(metadata);
    if (!directSession) return metadata;

    const current = readDirectSessionFollowPolicyV1(directSession.followPolicyV1) ?? null;
    const nextUpdatedAtMs = typeof params.updatedAtMs === 'number' && Number.isFinite(params.updatedAtMs)
        ? Math.max(0, Math.trunc(params.updatedAtMs))
        : undefined;
    if (current?.policy === params.policy && current?.updatedAtMs === nextUpdatedAtMs) return metadata;

    return {
        ...metadata,
        directSessionV1: {
            ...directSession,
            followPolicyV1: buildDirectSessionFollowPolicyV1({
                policy: params.policy,
                ...(nextUpdatedAtMs !== undefined ? { updatedAtMs: nextUpdatedAtMs } : {}),
            }),
        },
    };
}
