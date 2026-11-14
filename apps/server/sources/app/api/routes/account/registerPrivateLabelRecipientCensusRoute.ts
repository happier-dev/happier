import { z } from 'zod/mini';

import {
    PrivateLabelRecipientCensusRequestV1Schema,
    PrivateLabelRecipientCensusResponseV1Schema,
} from '@happier-dev/protocol/crypto/privateLabelRecipientCensusV1';

import { AccountRouteAuthenticationForbiddenResponseSchema } from '@/app/api/utils/enableAuthentication';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { readSavedSecretAudienceRecipientEnvelopeCensusInTx } from '@/app/encryption/savedSecretRecipientEnvelopeCensus';
import {
    qualifyTeamOperationAuthenticationInTx,
    readTeamOperationAuthenticationFromRequest,
    resolveTeamActorContextInTx,
    type TeamActorContext,
} from '@/app/teams/actorContext';
import { inReadSnapshot } from '@/storage/inTx';
import type { Fastify } from '../../types';

const PrivateLabelRecipientCensusErrorV1Schema = z.strictObject({
    error: z.enum(['forbidden', 'encryption_unavailable', 'invalid_request']),
});

export const PRIVATE_LABEL_RECIPIENT_CENSUS_PATH = '/v1/account/private-labels/recipient-census';
export const ACCOUNT_DIRECTORY_PRIVATE_LABEL_RECIPIENT_CENSUS_PATH = '/v1/account-directory/private-labels/recipient-census';

async function admitTeamRecipientCensusReadInTx(
    tx: Parameters<typeof resolveTeamActorContextInTx>[0],
    input: Readonly<{ teamId: string; accountId: string; request: Parameters<typeof readTeamOperationAuthenticationFromRequest>[0] }>,
): Promise<TeamActorContext | null> {
    const context = await resolveTeamActorContextInTx(tx, { teamId: input.teamId, actorAccountId: input.accountId });
    if (!context || !context.readsTeamForRecovery) return null;
    if (context.ownerRequired && context.homeAuthority.manageAllTeams) return context;
    const qualification = await qualifyTeamOperationAuthenticationInTx(tx, {
        context,
        ...readTeamOperationAuthenticationFromRequest(input.request),
    });
    return qualification.ok ? context : null;
}

/** Register one authenticated projection of the canonical census handler. */
function registerRecipientCensusRoute(app: Fastify, input: Readonly<{
    path: string;
    /** Directory credentials may only prepare labels whose audience is themselves. */
    accountDirectoryOnly: boolean;
}>): void {
    app.post(input.path, {
        ...(input.accountDirectoryOnly ? { config: { allowAccountDirectoryToken: true as const } } : {}),
        preHandler: input.accountDirectoryOnly ? [app.authenticate] : app.authenticate,
        schema: {
            body: PrivateLabelRecipientCensusRequestV1Schema,
            response: {
                200: PrivateLabelRecipientCensusResponseV1Schema,
                400: PrivateLabelRecipientCensusErrorV1Schema,
                // `app.authenticate` can refuse the wrong credential class
                // before this handler with its canonical person-required body.
                403: z.union([
                    PrivateLabelRecipientCensusErrorV1Schema,
                    AccountRouteAuthenticationForbiddenResponseSchema,
                ]),
                409: PrivateLabelRecipientCensusErrorV1Schema,
            },
        },
    }, async (request, reply) => {
        const parsed = PrivateLabelRecipientCensusRequestV1Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
        // A Directory credential is intentionally narrower than a Home session:
        // it can prepare its own Account labels but never enumerate a Team's
        // audience. The normal path remains the only Team-census entry point.
        if (input.accountDirectoryOnly && parsed.data.owner.kind !== 'account') {
            return reply.code(403).send({ error: 'forbidden' });
        }
        const result = await inReadSnapshot(async tx => {
            if (parsed.data.owner.kind === 'account' && parsed.data.owner.accountId !== request.userId) {
                return { kind: 'forbidden' } as const;
            }
            if (parsed.data.owner.kind === 'team') {
                const admitted = await admitTeamRecipientCensusReadInTx(tx, {
                    teamId: parsed.data.owner.teamId,
                    accountId: request.userId,
                    request,
                });
                if (!admitted) return { kind: 'forbidden' } as const;
            }
            const author = await tx.account.findUnique({
                where: { id: request.userId },
                select: { encryptionMode: true },
            });
            const mode = author && resolveEffectiveAccountEncryptionModeFromAccountRow(author);
            if (!mode || mode.status !== 'ready') return { kind: 'encryption_unavailable' } as const;
            const census = await readSavedSecretAudienceRecipientEnvelopeCensusInTx(tx, {
                ownerAccountId: request.userId,
                teamIds: parsed.data.owner.kind === 'team' ? [parsed.data.owner.teamId] : [],
            });
            return {
                kind: 'ready' as const,
                contentEncryptionMode: mode.mode,
                recipients: census.recipients,
            };
        });
        if (result.kind === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
        if (result.kind === 'encryption_unavailable') return reply.code(409).send({ error: 'encryption_unavailable' });
        return reply.send({
            contentEncryptionMode: result.contentEncryptionMode,
            recipients: result.recipients,
        });
    });
}

/**
 * The normal Home-facing producer. It derives current Team membership and
 * Account recipient-key readiness from the Saved Secret owner; callers supply
 * neither list nor key material.
 */
export function registerPrivateLabelRecipientCensusRoute(app: Fastify): void {
    registerRecipientCensusRoute(app, {
        path: PRIVATE_LABEL_RECIPIENT_CENSUS_PATH,
        accountDirectoryOnly: false,
    });
}

/** Directory transport reuses the same handler but can prepare Account labels only. */
export function registerAccountDirectoryPrivateLabelRecipientCensusRoute(app: Fastify): void {
    registerRecipientCensusRoute(app, {
        path: ACCOUNT_DIRECTORY_PRIVATE_LABEL_RECIPIENT_CENSUS_PATH,
        accountDirectoryOnly: true,
    });
}
