import {
    CLIENT_UPGRADE_REQUIRED_HTTP_STATUS,
    parseClientCompatibilityHttpHeadersV1,
} from '@happier-dev/protocol';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { evaluateSessionSyncCompatibility } from './decision';
import { resolveSessionSyncCompatibilityPolicy } from './policy';

export async function enforceSessionSyncCompatibilityForHttpRequest(
    request: FastifyRequest,
    reply: FastifyReply,
    env: NodeJS.ProcessEnv,
): Promise<boolean> {
    const evaluation = evaluateSessionSyncCompatibility(
        parseClientCompatibilityHttpHeadersV1(request.headers),
        resolveSessionSyncCompatibilityPolicy(env),
    );
    request.sessionSyncCompatibility = evaluation;
    if (!evaluation.accepted && evaluation.upgradeRequired !== null) {
        await reply.code(CLIENT_UPGRADE_REQUIRED_HTTP_STATUS).send(evaluation.upgradeRequired);
    }
    return !reply.sent;
}
