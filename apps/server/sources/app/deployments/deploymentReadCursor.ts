import { z } from 'zod/mini';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { decryptString, encryptString } from '@/modules/encrypt';
import type { DeploymentEnvironmentListInputV1 } from '@happier-dev/protocol';

const sealed = z.strictObject({ t: z.literal('sealed_v1'), c: z.string().check(z.minLength(1)) });
const path = (actorAccountId: string, input: DeploymentEnvironmentListInputV1) => [
    'deployments', 'environments', 'list', 'v1',
    JSON.stringify([actorAccountId, input.serverId, input.projectSourceId ?? null, input.machineId ?? null,
        ...(input.environmentIds === undefined ? [] : [[...new Set(input.environmentIds)].sort()]),
        ...(input.includeDeleted ? ['includeDeleted'] : []),
        ...(input.previewRepositoryId === undefined ? [] : ['previews', input.previewRepositoryId,
            [...new Set(input.previewPullRequestIds)].sort()]),
        ...(input.previewTemplateEnvironmentId === undefined ? [] : ['previewTemplate', input.previewTemplateEnvironmentId])]),
];

/** A filtered-out candidate must advance the page without disclosing its identity. */
export function sealDeploymentReadCursor(actorAccountId: string, input: DeploymentEnvironmentListInputV1, cursor: string): string {
    return JSON.stringify({ t: 'sealed_v1', c: encodeBase64(encryptString(path(actorAccountId, input), cursor)) });
}

/** Existing admitted-row cursors stay valid; opaque positions are bound to the exact reader/filter. */
export function openDeploymentReadCursor(actorAccountId: string, input: DeploymentEnvironmentListInputV1): string | undefined {
    if (!input.cursor?.startsWith('{')) return input.cursor;
    return decryptString(path(actorAccountId, input), decodeBase64(sealed.parse(JSON.parse(input.cursor)).c));
}
