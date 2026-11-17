import { z } from 'zod/mini';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { decryptString, encryptString } from '@/modules/encrypt';
import type { DeploymentEnvironmentListInputV1, DeploymentTargetLinksListInputV1 } from '@happier-dev/protocol';
import { normalizeScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { deploymentFailure } from './deploymentAdmission';

const sealed = z.strictObject({ t: z.literal('sealed_v1'), c: z.string().check(z.minLength(1)) });
type DeploymentListCursorInput = DeploymentEnvironmentListInputV1 | DeploymentTargetLinksListInputV1 | Readonly<{
    serverId: string; projectSourceId?: string; cursor?: string; pageKind: 'domains' | 'data';
}>;
const path = (actorAccountId: string, input: DeploymentListCursorInput) => 'pageKind' in input ? [
    'deployments', input.pageKind, 'page', 'v1', JSON.stringify([actorAccountId, input.serverId, input.projectSourceId ?? null]),
] : 'scope' in input ? [
    'deployments', 'targets', 'list', 'v1',
    JSON.stringify([actorAccountId, input.serverId, input.scope.kind,
        input.scope.kind === 'account' ? input.scope.accountId : input.scope.teamId,
        input.selection?.targetKind ?? null, input.selection?.source.kind ?? null,
        input.selection?.source.kind === 'plugin' ? input.selection.source.contribution.pluginId : input.selection?.source.id ?? null,
        input.selection?.source.kind === 'plugin' ? input.selection.source.contribution.localId : null]),
] : [
    'deployments', 'environments', 'list', 'v1',
    JSON.stringify([actorAccountId, input.serverId, input.projectSourceId ?? null, input.machineId ?? null,
        ...(input.environmentIds === undefined ? [] : [[...new Set(input.environmentIds)].sort()]),
        ...(input.includeDeleted ? ['includeDeleted'] : []),
        ...(input.previewRepositoryId === undefined ? [] : ['previews', input.previewRepositoryId,
            [...new Set(input.previewPullRequestIds)].sort()]),
        ...(input.previewRepository === undefined ? [] : ['previewRepository', normalizeScmHostingRepositoryIdentity(input.previewRepository),
            [...new Set(input.previewPullRequestIds)].sort()]),
        ...(input.previewTemplateEnvironmentId === undefined ? [] : ['previewTemplate', input.previewTemplateEnvironmentId]),
        ...(input.previewCompanionOfEnvironmentId === undefined ? [] : ['previewCompanion', input.previewCompanionOfEnvironmentId])]),
];

/** A filtered-out candidate must advance the page without disclosing its identity. */
export function sealDeploymentReadCursor(actorAccountId: string, input: DeploymentListCursorInput, cursor: string): string {
    return JSON.stringify({ t: 'sealed_v1', c: encodeBase64(encryptString(path(actorAccountId, input), cursor)) });
}

/** A cursor sealed for another reader or filter, or altered, is refused with a private phase only. */
export function refuseDeploymentReadCursor() {
    return deploymentFailure('deployment_invalid', { phase: 'deployment.read.cursor', causeKind: 'access_denied' });
}

/** Existing admitted-row cursors stay valid; opaque positions are bound to the exact reader/filter. */
export function openDeploymentReadCursor(actorAccountId: string, input: DeploymentListCursorInput): string | undefined {
    if (!input.cursor?.startsWith('{')) {
        if ('pageKind' in input && input.cursor) throw new Error('An account page requires an opaque continuation');
        return input.cursor;
    }
    return decryptString(path(actorAccountId, input), decodeBase64(sealed.parse(JSON.parse(input.cursor)).c));
}
