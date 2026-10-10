import { z } from 'zod';
import {
    RunnerActivationCreateRequestV1Schema,
    RunnerEndpointFactsRecipientV1Schema,
} from '@happier-dev/protocol/ephemeralRunner/activation';
import { RunnerActivationProjectionV1Schema } from '@happier-dev/protocol/ephemeralRunner/projection';
import { RunnerClaimV1Schema, RunnerEndpointFactsV1Schema } from '@happier-dev/protocol/ephemeralRunner/endpoint';
import { RunnerActivationReviewV1Schema } from '@happier-dev/protocol/ephemeralRunner/review';
import { RunnerConsentV1Schema } from '@happier-dev/protocol/ephemeralRunner/consent';
import { RunnerReadinessV1Schema } from '@happier-dev/protocol/ephemeralRunner/readiness';
import { RunnerActivationProgressPhaseV1Schema } from '@happier-dev/protocol/ephemeralRunner/progress';
import { RunnerActivationProgressUpdateV1Schema } from '@happier-dev/protocol/ephemeralRunner/progressProof';
import {
    RunnerMaterializationRequestV1Schema,
    RunnerMaterializationResponseV1Schema,
} from '@happier-dev/protocol/ephemeralRunner/materialization';
import {
    RunnerEndpointProjectionRequestV1Schema,
    RunnerEndpointProjectionResponseV1Schema,
    RunnerEndpointDeclineResponseV1Schema,
} from '@happier-dev/protocol/ephemeralRunner/endpointProjection';
import { RunnerArtifactAvailabilityProjectionV1Schema } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import { RunnerServerErrorV1Schema } from '@happier-dev/protocol/ephemeralRunner/errors';
import { RunnerCredentialSelectionResolutionRequestV1Schema, RunnerCredentialSelectionResolutionResponseV1Schema } from '@happier-dev/protocol/teams';
import { RPC_METHODS } from '@happier-dev/protocol';
import {
    EPHEMERAL_RUNNER_ARTIFACTS_PATH_V1,
    EPHEMERAL_RUNNER_CREATOR_RECIPIENT_PATH_V1,
} from '@happier-dev/protocol/ephemeralRunner/routes';
import { claimEphemeralRunnerActivation } from './activationClaim';
import { storeRunnerEndpointFacts } from './activationFacts';
import type { Fastify } from '@/app/api/types';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { requirePresentUser } from '@/app/api/utils/requirePresentUser';
import { createServerFeatureGatedRouteApp } from '@/app/features/catalog/serverFeatureGate';
import { readCachedServerIdentityIdForHotPath } from '@/app/serverIdentity/serverIdentity';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { cancelEphemeralRunnerActivation, createEphemeralRunnerActivation, readDraftEphemeralRunnerActivation, readEphemeralRunnerActivation } from './activationService';
import {
    storeRunnerActivationConsent,
    storeRunnerActivationPhase,
    storeRunnerActivationReadiness,
    storeRunnerActivationReview,
} from './activationProgress';
import { materializeEphemeralRunner } from './materializeEphemeralRunner';
import { readEphemeralRunnerEndpointProjection } from './endpointProjection';
import { declineEphemeralRunnerActivationByEndpoint } from './endpointDecline';
import { readPublishedRunnerArtifacts, runnerArtifactPublicationSnapshots } from './runnerArtifactAvailability';
import { readRunnerCreatorRecipient } from './activationCurrentness';
import { resolveRunnerCredentialSelection } from './credentialSelection';
import { getMachineDaemonPresenceInventory } from '@/app/machines/machineDaemonPresence';
import { createTeamCredentialPoolSourceEligibilityReader } from '@/app/teams/credentials/poolSourceEligibility';
import { normalizePublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { log } from '@/utils/logging/log';

// One Runner error vocabulary: the Protocol owner types every failure reply on
// this family, so a new literal here is a compile error until it is added there.
const ErrorSchema = RunnerServerErrorV1Schema;

/** Creator operations share one feature gate and the activation transaction owner. */
export function registerEphemeralRunnerRoutes(rawApp: Fastify, env: NodeJS.ProcessEnv = process.env): void {
    const app = createServerFeatureGatedRouteApp(rawApp, 'sessions.ephemeralRunner', env);
    // The Home's existing public release channel is the only Runner publication
    // ring decision. Resolve it once at composition so listing and the exact
    // activation admission cannot silently read different release rings.
    const runnerReleaseRing = normalizePublicReleaseRingId(env.HAPPIER_PUBLIC_RELEASE_CHANNEL) || 'stable';
    const runnerArtifactSource = {
        channel: runnerReleaseRing,
        publicationSnapshots: runnerArtifactPublicationSnapshots,
    } as const;
    app.get(EPHEMERAL_RUNNER_ARTIFACTS_PATH_V1, {
        preHandler: [app.authenticate, requirePresentUser],
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, 'auth.pairing.status') },
        schema: {
            querystring: z.object({ version: z.string().min(1).optional() }).strict(),
            response: { 200: RunnerArtifactAvailabilityProjectionV1Schema, 503: ErrorSchema },
        },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'private, no-cache');
        try {
            return reply.send({
                status: 'available',
                artifacts: await readPublishedRunnerArtifacts({
                    ...runnerArtifactSource,
                    version: request.query.version,
                }),
            });
        } catch {
            log({ module: 'ephemeral-runner', level: 'error', errorCode: 'runner_artifact_publication_unavailable' },
                'Runner artifact publication is unavailable');
            return reply.code(503).send({ error: 'runner_artifact_publication_unavailable' });
        }
    });
    app.get(EPHEMERAL_RUNNER_CREATOR_RECIPIENT_PATH_V1, {
        preHandler: [app.authenticate, requirePresentUser],
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, 'auth.pairing.status') },
        schema: { response: { 200: RunnerEndpointFactsRecipientV1Schema, 503: ErrorSchema } },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'private, no-store');
        const recipient = await readRunnerCreatorRecipient(request.userId);
        return recipient ? reply.send(recipient) : reply.code(503).send({ error: 'runner_creator_currentness_unavailable' });
    });
    app.post('/v1/ephemeral-runners/activations', {
        preHandler: [app.authenticate, requirePresentUser],
        // Reuse the catalog's interactive proof-creation budget; no route-local limiter.
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, 'auth.pairing.start') },
        schema: {
            body: RunnerActivationCreateRequestV1Schema,
            response: {
                200: z.object({ status: z.literal('created'), activation: RunnerActivationProjectionV1Schema }).strict(),
                400: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 503: ErrorSchema,
            },
        },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const homeServerIdentityId = readCachedServerIdentityIdForHotPath(env);
        if (!homeServerIdentityId) return reply.code(503).send({ error: 'runner_unavailable' });
        const result = await createEphemeralRunnerActivation({
            creatorAccountId: request.userId,
            request: request.body,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        }, {
            homeServerIdentityId,
            artifactSource: runnerArtifactSource,
        });
        if (result.status === 'created') return reply.send(result);
        if (result.status === 'artifact_unavailable') {
            if (result.reason === 'publication_unavailable') {
                log({ module: 'ephemeral-runner', level: 'error', errorCode: 'runner_artifact_publication_unavailable' },
                    'Runner artifact publication is unavailable');
                return reply.code(503).send({ error: 'runner_artifact_publication_unavailable' });
            }
            if (result.reason === 'artifact_identity_mismatch') {
                return reply.code(409).send({ error: 'runner_artifact_identity_mismatch' });
            }
            // Declared but unverifiable release bytes. Absence would tell the
            // creator to wait for a target that is in fact published, and 503
            // would tell them to retry a publication that cannot become valid.
            if (result.reason === 'publication_invalid') {
                return reply.code(409).send({ error: 'runner_artifact_publication_invalid' });
            }
            return reply.code(404).send({
                error: result.reason === 'target_not_published'
                    ? 'runner_artifact_target_not_published'
                    : 'runner_artifact_not_published',
            });
        }
        if (result.status === 'creator_unavailable') return reply.code(403).send({ error: 'forbidden' });
        if (result.status === 'authentication_evidence_unavailable') {
            return reply.code(409).send({ error: 'credential_authentication_evidence_unavailable' });
        }
        if (result.status === 'draft_unavailable') return reply.code(404).send({ error: 'not_found' });
        if (result.status === 'conflict') return reply.code(409).send({ error: 'runner_activation_conflict' });
        // The remaining creator rejections name themselves in the one Runner
        // error vocabulary rather than leaking the domain result status.
        return result.status === 'recipient_mismatch'
            ? reply.code(400).send({ error: 'recipient_mismatch' })
            : reply.code(400).send({ error: 'invalid_request' });
    });
    app.get('/v1/ephemeral-runners/activations', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, 'auth.pairing.status') },
        schema: {
            querystring: z.object({ draftId: RunnerActivationCreateRequestV1Schema.shape.draftId }).strict(),
            response: { 200: RunnerActivationProjectionV1Schema, 400: ErrorSchema, 404: ErrorSchema },
        },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const activation = await readDraftEphemeralRunnerActivation({ creatorAccountId: request.userId, draftId: request.query.draftId });
        return activation ? reply.send(activation) : reply.code(404).send({ error: 'not_found' });
    });
    app.get('/v1/ephemeral-runners/activations/:activationId', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, 'auth.pairing.status') },
        schema: {
            params: z.object({ activationId: z.string().uuid() }).strict(),
            response: { 200: RunnerActivationProjectionV1Schema, 404: ErrorSchema },
        },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const activation = await readEphemeralRunnerActivation({ creatorAccountId: request.userId, activationId: request.params.activationId });
        return activation ? reply.send(activation) : reply.code(404).send({ error: 'not_found' });
    });
    app.delete('/v1/ephemeral-runners/activations/:activationId', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, 'auth.pairing.request') },
        schema: {
            params: z.object({ activationId: z.string().uuid() }).strict(),
            response: { 200: RunnerActivationProjectionV1Schema, 404: ErrorSchema },
        },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const activation = await cancelEphemeralRunnerActivation({ creatorAccountId: request.userId, activationId: request.params.activationId });
        return activation ? reply.send(activation) : reply.code(404).send({ error: 'not_found' });
    });
    app.post('/v1/ephemeral-runners/activations/:activationId/endpoint/claim', {
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, 'auth.pairing.request') },
        schema: {
            params: z.object({ activationId: z.string().uuid() }).strict(),
            body: RunnerClaimV1Schema,
            response: { 200: z.object({ status: z.literal('claimed'), claim: RunnerClaimV1Schema }).strict(), 404: ErrorSchema },
        },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const homeServerIdentityId = readCachedServerIdentityIdForHotPath(env);
        if (!homeServerIdentityId) return reply.code(404).send({ error: 'runner_activation_unavailable' });
        const result = await claimEphemeralRunnerActivation({ activationId: request.params.activationId, claim: request.body }, { homeServerIdentityId });
        return result.status === 'claimed' ? reply.send(result) : reply.code(404).send({ error: 'runner_activation_unavailable' });
    });
    app.put('/v1/ephemeral-runners/activations/:activationId/endpoint/facts', {
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, 'auth.pairing.request') },
        schema: {
            params: z.object({ activationId: z.string().uuid() }).strict(),
            body: RunnerEndpointFactsV1Schema,
            response: { 200: z.object({ status: z.literal('stored'), endpointFacts: RunnerEndpointFactsV1Schema }).strict(), 400: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema },
        },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const homeServerIdentityId = readCachedServerIdentityIdForHotPath(env);
        if (!homeServerIdentityId) return reply.code(404).send({ error: 'runner_activation_unavailable' });
        const result = await storeRunnerEndpointFacts({ activationId: request.params.activationId, endpointFacts: request.body }, { homeServerIdentityId });
        if (result.status === 'stored') return reply.send(result);
        if (result.status === 'conflict') return reply.code(409).send({ error: 'runner_endpoint_facts_conflict' });
        if (result.status === 'content_mode_mismatch') return reply.code(400).send({ error: 'runner_endpoint_facts_mode_mismatch' });
        return reply.code(404).send({ error: 'runner_activation_unavailable' });
    });
    app.post('/v1/ephemeral-runners/activations/:activationId/endpoint/projection', {
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, 'auth.pairing.status') },
        schema: {
            params: z.object({ activationId: z.string().uuid() }).strict(),
            body: RunnerEndpointProjectionRequestV1Schema,
            response: { 200: RunnerEndpointProjectionResponseV1Schema },
        },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        return reply.send(await readEphemeralRunnerEndpointProjection({
            activationId: request.params.activationId,
            request: request.body,
        }));
    });
    app.put('/v1/ephemeral-runners/activations/:activationId/endpoint/progress', {
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, 'auth.pairing.request') },
        schema: {
            params: z.object({ activationId: z.string().uuid() }).strict(),
            body: RunnerActivationProgressUpdateV1Schema,
            response: {
                200: z.object({ status: z.literal('stored'), progressPhase: RunnerActivationProgressPhaseV1Schema }).strict(),
                400: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema,
            },
        },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const result = await storeRunnerActivationPhase({ activationId: request.params.activationId, update: request.body });
        if (result.status === 'stored') return reply.send({ status: 'stored', progressPhase: result.value });
        if (result.status === 'invalid_proof') return reply.code(400).send({ error: 'invalid_proof' });
        return result.status === 'conflict'
            ? reply.code(409).send({ error: 'activation_progress_conflict' })
            : reply.code(404).send({ error: 'runner_activation_unavailable' });
    });
    app.delete('/v1/ephemeral-runners/activations/:activationId/endpoint', {
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, 'auth.pairing.request') },
        schema: {
            params: z.object({ activationId: z.string().uuid() }).strict(),
            body: RunnerEndpointProjectionRequestV1Schema,
            response: { 200: RunnerEndpointDeclineResponseV1Schema },
        },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        return reply.send(await declineEphemeralRunnerActivationByEndpoint({
            activationId: request.params.activationId,
            request: request.body,
        }));
    });
    app.put('/v1/ephemeral-runners/activations/:activationId/review', {
        preHandler: [app.authenticate, requirePresentUser],
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, 'auth.pairing.request') },
        schema: {
            params: z.object({ activationId: z.string().uuid() }).strict(),
            body: RunnerActivationReviewV1Schema,
            response: {
                200: z.object({ status: z.literal('stored'), review: RunnerActivationReviewV1Schema }).strict(),
                400: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema,
            },
        },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const result = await storeRunnerActivationReview({
            creatorAccountId: request.userId,
            activationId: request.params.activationId,
            review: request.body,
        });
        if (result.status === 'stored') return reply.send({ status: 'stored', review: result.value });
        // A rejected scoped Machine-key proof is an invalid proof, not a missing
        // activation; consent and readiness already report it that way.
        if (result.status === 'invalid_proof') return reply.code(400).send({ error: 'invalid_proof' });
        return result.status === 'conflict'
            ? reply.code(409).send({ error: 'review_conflict' })
            : reply.code(404).send({ error: 'not_found' });
    });
    app.post('/v1/ephemeral-runners/activations/:activationId/credential-selection', {
        preHandler: [app.authenticate, requirePresentUser],
        attachValidation: true,
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, 'auth.pairing.status') },
        schema: {
            params: z.object({ activationId: z.string().uuid() }).strict(),
            body: RunnerCredentialSelectionResolutionRequestV1Schema,
            response: { 200: RunnerCredentialSelectionResolutionResponseV1Schema, 400: ErrorSchema },
        },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'private, no-store');
        if (request.validationError) return reply.code(400).send({ error: 'invalid_input' });
        // Pool member eligibility is asked over live Machine RPC, so the
        // selection follows the client: a closed request stops asking.
        const eligibilityAbort = new AbortController();
        const abortEligibility = () => eligibilityAbort.abort(new Error('runner_credential_selection_client_closed'));
        request.raw.once('aborted', abortEligibility);
        reply.raw.once('close', abortEligibility);
        return reply.send(await resolveRunnerCredentialSelection({
            creatorAccountId: request.userId,
            activationId: request.params.activationId,
            request: request.body,
            authentication: readSessionAccessAuthenticationFromRequest(request),
            signal: eligibilityAbort.signal,
            readCurrentPresence: async custodianAccountId => await getMachineDaemonPresenceInventory({
                accountId: custodianAccountId,
                io: app.machineDaemonPresence,
            }),
            readPoolSourceEligibility: createTeamCredentialPoolSourceEligibilityReader(app.forwardRpcForUser),
            readProviderProjection: async ({ custodianAccountId, brokerMachineId, source, request: selectionRequest }) => {
                const result = await app.forwardRpcForUser({
                    userId: custodianAccountId,
                    method: `${brokerMachineId}:${RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION}`,
                    params: {
                        machineId: brokerMachineId,
                        agentTargetKey: selectionRequest.application.agentTargetKey,
                        application: selectionRequest.application,
                        ...(source.kind === 'provider_connection'
                            ? { providerConnection: {
                                connectionId: source.connectionId,
                                expectedConnectionSecurityFingerprint: source.connectionSecurityFingerprint,
                            } }
                            : { connectedAccountTarget: source.target }),
                    },
                });
                if (!result.ok) throw new Error('runner_provider_projection_unavailable');
                return result.result;
            },
        }));
    });
    app.put('/v1/ephemeral-runners/activations/:activationId/endpoint/consent', {
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, 'auth.pairing.request') },
        schema: {
            params: z.object({ activationId: z.string().uuid() }).strict(),
            body: RunnerConsentV1Schema,
            response: {
                200: z.object({ status: z.literal('stored'), consent: RunnerConsentV1Schema }).strict(),
                400: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema,
            },
        },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const result = await storeRunnerActivationConsent({ activationId: request.params.activationId, consent: request.body });
        if (result.status === 'stored') return reply.send({ status: 'stored', consent: result.value });
        if (result.status === 'invalid_proof') return reply.code(400).send({ error: 'invalid_proof' });
        return result.status === 'conflict'
            ? reply.code(409).send({ error: 'activation_conflict' })
            : reply.code(404).send({ error: 'not_found' });
    });
    app.put('/v1/ephemeral-runners/activations/:activationId/endpoint/readiness', {
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, 'auth.pairing.request') },
        schema: {
            params: z.object({ activationId: z.string().uuid() }).strict(),
            body: RunnerReadinessV1Schema,
            response: {
                200: z.object({ status: z.literal('stored'), readiness: RunnerReadinessV1Schema }).strict(),
                400: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema,
            },
        },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const result = await storeRunnerActivationReadiness({ activationId: request.params.activationId, readiness: request.body });
        if (result.status === 'stored') return reply.send({ status: 'stored', readiness: result.value });
        if (result.status === 'invalid_proof') return reply.code(400).send({ error: 'invalid_proof' });
        return result.status === 'conflict'
            ? reply.code(409).send({ error: 'activation_conflict' })
            : reply.code(404).send({ error: 'not_found' });
    });
    app.put('/v1/ephemeral-runners/activations/:activationId/session', {
        preHandler: [app.authenticate, requirePresentUser],
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, 'auth.pairing.request') },
        schema: {
            params: z.object({ activationId: z.string().uuid() }).strict(),
            body: RunnerMaterializationRequestV1Schema,
            response: {
                200: RunnerMaterializationResponseV1Schema,
                400: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema,
            },
        },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (request.body.activationId !== request.params.activationId) {
            return reply.code(400).send({ error: 'invalid_request' });
        }
        const result = await materializeEphemeralRunner({
            creatorAccountId: request.userId,
            request: request.body,
            authentication: readSessionAccessAuthenticationFromRequest(request),
            env,
        });
        if (result.status === 'materialized') return reply.send(result);
        if (result.status === 'conflict') return reply.code(409).send({ error: 'materialization_conflict' });
        if (result.status === 'unavailable') return reply.send(result);
        return reply.code(400).send({ error: 'invalid_request' });
    });
}
