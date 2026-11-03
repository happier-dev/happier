import { SavedSecretDisclosureRecordV1Schema, SavedSecretCopyRecordV1Schema, SavedSecretDisclosureRecordResultV1Schema,
    SavedSecretDisclosureHistoryV1Schema, SavedSecretResourceActionErrorV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { TeamCredentialResourceActivityReadInputV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import type { Fastify } from '@/app/api/types';
import { requirePresentUser } from '@/app/api/utils/requirePresentUser';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { readSavedSecretDisclosureActivityInTx, recordSavedSecretCopyActivityInTx,
    recordSavedSecretDisclosureActivityInTx } from '@/app/teams/credentials/resourceActivity';
import { inReadSnapshot, inTx } from '@/storage/inTx';

function activityError(error: 'resource_not_found' | 'resource_forbidden' | 'resource_changed' | 'invalid_resource_input') {
    return error === 'resource_forbidden' ? 'forbidden' as const : error === 'invalid_resource_input' ? 'invalid_resource' as const : error;
}
function statusFor(error: ReturnType<typeof activityError>) {
    return error === 'forbidden' ? 403 : error === 'resource_not_found' ? 404 : error === 'resource_changed' ? 409 : 400;
}

/** Storage/authentication only: client disclosure and clipboard effects stay in the app. */
export function registerSavedSecretActivityRoutes(app: Fastify): void {
    const response = { 400: SavedSecretResourceActionErrorV1Schema, 403: SavedSecretResourceActionErrorV1Schema,
        404: SavedSecretResourceActionErrorV1Schema, 409: SavedSecretResourceActionErrorV1Schema };
    app.post('/v1/account/saved-secrets/resources/activity', {
        preHandler: [app.authenticate, requirePresentUser],
        schema: { body: SavedSecretDisclosureRecordV1Schema, response: { ...response, 200: SavedSecretDisclosureRecordResultV1Schema } },
    }, async (request, reply) => {
        if (request.authTokenKind !== 'account') return reply.code(403).send({ error: 'forbidden' });
        const input = request.body;
        const ref = parseSavedSecretRefV1(input.ref);
        if (ref.kind !== 'shared_resource') return reply.code(400).send({ error: 'invalid_resource' });
        const result = await inTx(tx => recordSavedSecretDisclosureActivityInTx(tx, {
            ...input, resourceId: ref.resourceId, actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }));
        if (result.ok) return reply.send({ historyEntryId: result.historyEntryId });
        const error = activityError(result.error);
        return reply.code(statusFor(error)).send({ error });
    });
    app.post('/v1/account/saved-secrets/resources/activity/copy', {
        preHandler: [app.authenticate, requirePresentUser],
        schema: { body: SavedSecretCopyRecordV1Schema, response: { ...response, 200: SavedSecretDisclosureRecordResultV1Schema } },
    }, async (request, reply) => {
        if (request.authTokenKind !== 'account') return reply.code(403).send({ error: 'forbidden' });
        const input = request.body;
        const ref = parseSavedSecretRefV1(input.ref);
        if (ref.kind !== 'shared_resource') return reply.code(400).send({ error: 'invalid_resource' });
        const result = await inTx(tx => recordSavedSecretCopyActivityInTx(tx, {
            ...input, resourceId: ref.resourceId, actorAccountId: request.userId,
            authentication: readTeamOperationAuthenticationFromRequest(request),
        }));
        if (result.ok) return reply.send({ historyEntryId: result.historyEntryId });
        const error = activityError(result.error);
        return reply.code(statusFor(error)).send({ error });
    });
    app.post('/v1/account/saved-secrets/resources/activity/read', {
        preHandler: [app.authenticate, requirePresentUser],
        // The generalized history retains the existing cursor and paging input contract.
        schema: { body: TeamCredentialResourceActivityReadInputV1Schema, response: { ...response, 200: SavedSecretDisclosureHistoryV1Schema } },
    }, async (request, reply) => {
        if (request.authTokenKind !== 'account') return reply.code(403).send({ error: 'forbidden' });
        const result = await inReadSnapshot(tx => readSavedSecretDisclosureActivityInTx(tx, {
            ...request.body, actorAccountId: request.userId, authentication: readTeamOperationAuthenticationFromRequest(request),
        }));
        if (result.ok) return reply.send(result.page);
        const error = activityError(result.error);
        return reply.code(statusFor(error)).send({ error });
    });
}
