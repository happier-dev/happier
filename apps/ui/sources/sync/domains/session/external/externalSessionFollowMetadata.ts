import { buildExternalSessionFollowPolicyV1, readExternalSessionFollowPolicyV1, type ExternalSessionFollowPolicy } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { updateLinkedExternalSessionFollowMetadataV1 } from '@happier-dev/protocol/sessions/external/followLifecycleV1';

import type { Metadata } from '@happier-dev/session-core/state';

import { readExternalSessionLink } from './readExternalSessionLink';

export type { ExternalSessionFollowPolicy } from '@happier-dev/protocol';

export function readExternalSessionFollowPolicy(metadata: unknown): ExternalSessionFollowPolicy {
    const externalSession = readExternalSessionLink(metadata);
    return readExternalSessionFollowPolicyV1(externalSession?.followPolicyV1)?.policy ?? 'attached_only';
}

export function updateMetadataWithExternalSessionFollowPolicy(
    metadata: Metadata,
    params: Readonly<{
        policy: ExternalSessionFollowPolicy;
        updatedAtMs?: number;
    }>,
): Metadata {
    const externalSession = readExternalSessionLink(metadata);
    if (!externalSession) return metadata;

    const current = readExternalSessionFollowPolicyV1(externalSession.followPolicyV1) ?? null;
    const nextUpdatedAtMs = typeof params.updatedAtMs === 'number' && Number.isFinite(params.updatedAtMs)
        ? Math.max(0, Math.trunc(params.updatedAtMs))
        : undefined;
    if (current?.policy === params.policy && current?.updatedAtMs === nextUpdatedAtMs) return metadata;

    return updateLinkedExternalSessionFollowMetadataV1(metadata, {
        followPolicyV1: buildExternalSessionFollowPolicyV1({
            policy: params.policy,
            ...(nextUpdatedAtMs !== undefined ? { updatedAtMs: nextUpdatedAtMs } : {}),
        }),
    }) as Metadata;
}
