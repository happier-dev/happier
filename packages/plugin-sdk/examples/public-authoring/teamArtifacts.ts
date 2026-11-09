import {
    isPluginActionApprovalRequestCreated,
    type ActionsService,
    type PluginActionInputById,
} from '@happier-dev/plugin-sdk/actions';
import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';

/** Use the invoking Account's host Actions; the host owns storage and key delivery. */
export async function createTeamDocument(
    actions: Pick<ActionsService, 'execute'>,
    teamId: string,
    document: PluginActionInputById['artifact.create'],
    options?: PluginCancellationOptions,
) {
    const created = await actions.execute('artifact.create', document, options);
    if (isPluginActionApprovalRequestCreated(created)) return created;
    // A created approval is not a created document. Keep the document receipt
    // when this separate sharing operation defers, so callers never recreate it.
    const sharing = await actions.execute('artifact.access.grants.set', {
        artifactId: created.artifactId,
        principal: { kind: 'team', teamId },
        accessLevel: 'edit',
    }, options);
    return { ...created, sharing };
}

/** Read using the recipient's invocation so the host opens their own envelope. */
export async function updateTeamDocument(
    actions: Pick<ActionsService, 'execute'>,
    artifactId: string,
    body: string,
    options?: PluginCancellationOptions,
) {
    const current = await actions.execute('artifact.get', { artifactId }, options);
    if (isPluginActionApprovalRequestCreated(current) || !current.artifact) return current;
    return actions.execute('artifact.update', {
        artifactId,
        expectedRevision: current.artifact.revision,
        header: current.artifact.header,
        body,
    }, options);
}
