import { ProviderBrokerActionOpenRequestV3Schema, ProviderBrokerActionOpenResponseV3Schema, ProviderBrokerActionAdmissionV3Schema, ProviderBrokerActionAdmissionResponseV3Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { openTeamCredentialActionBroker, admitTeamCredentialActionBrokerRequest } from './actionBrokerAdmission';
import { verifyProviderBrokerActionRouteGrantSignatureV3 } from '@/app/machines/peer/mediation/signProviderBrokerRouteGrantV1';
import { ProviderBrokerWatcherOpenRequestV1Schema, ProviderBrokerWatcherOpenResponseV1Schema, ProviderBrokerWatcherRefreshRequestV1Schema, ProviderBrokerWatcherRefreshResponseV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { PROVIDER_BROKER_OPEN_HTTP_PATH_V1, PROVIDER_BROKER_MODEL_CATALOG_AUTHORIZE_HTTP_PATH_V1, PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1, ProviderBrokerOpenRequestV1Schema, ProviderBrokerModelCatalogAuthorizationV1Schema, ProviderBrokerModelCatalogAuthorizationResponseV1Schema, ProviderBrokerOpenResponseV1Schema, ProviderBrokerRequestAdmissionV1Schema, ProviderBrokerRequestAdmissionResponseV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { TEAM_CREDENTIAL_EXTERNAL_PROVIDER_ADMISSION_HTTP_PATH_V1, TEAM_CREDENTIAL_EXTERNAL_PROVIDER_TERMINAL_USAGE_HTTP_PATH_V1, TEAM_CREDENTIAL_RESOURCE_TEST_ADMISSION_HTTP_PATH_V1, TeamCredentialExternalProviderAdmissionResponseV1Schema, TeamCredentialExternalProviderAdmissionV1Schema, TeamCredentialExternalProviderTerminalUsageResponseV1Schema, TeamCredentialExternalProviderTerminalUsageV1Schema, TeamCredentialExternalProviderModelCatalogAuthorizationV1Schema, TeamCredentialResourceTestAdmissionResponseV1Schema, TeamCredentialResourceTestAdmissionV1Schema } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';

import { z } from 'zod/mini';
import type { Fastify } from '@/app/api/types';
import { getMachineDaemonPresenceInventory } from '@/app/machines/machineDaemonPresence';
import { resolvePeerMediationGrantSigningConfig } from '@/app/machines/peer/mediation/mintDirectRouteGrantV1';
import { verifyProviderBrokerRouteGrantSignatureV1 } from '@/app/machines/peer/mediation/signProviderBrokerRouteGrantV1';
import { verifyRunnerBrokerOpenSelectionInTx } from '@/app/ephemeralRunner/runnerBrokerOpenSelection';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { inTx } from '@/storage/inTx';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createExecutionRunBrokerCurrentnessResolver } from './executionRunBrokerAuthorityResolver';
import { createTeamCredentialPoolSourceEligibilityReader } from './poolSourceEligibility';
import {
    admitTeamCredentialProviderBrokerRequest,
    authorizeTeamCredentialProviderModelCatalog,
    openRunnerTeamCredentialProviderBroker,
    openTeamCredentialProviderBroker,
    type TeamCredentialProviderBrokerOpenInput,
} from './providerBrokerAdmission';
import {
    admitTeamCredentialExternalProviderRequestInTx,
    authorizeTeamCredentialExternalProviderModelCatalogInTx,
    recordTeamCredentialExternalProviderTerminalUsageInTx,
} from './externalProviderBrokerAdmission';
import { admitTeamCredentialResourceTestRequestInTx } from './resourceTestBrokerAdmission';
import { readRequestHomeEnv } from '@/app/home/settings/requestHomeEnv';
import {
    PROVIDER_BROKER_ACCOUNT_OPEN_HTTP_PATH_V2, PROVIDER_BROKER_ACCOUNT_ADMIT_HTTP_PATH_V2,
    ProviderBrokerAccountOpenRequestV2Schema, ProviderBrokerAccountOpenResponseV2Schema,
    ProviderBrokerAccountAdmissionV2Schema, ProviderBrokerAccountAdmissionResponseV2Schema,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { openAccountConnectionProviderBroker, admitAccountConnectionProviderBroker } from '@/app/providers/providerBrokerAdmission';
import { verifyProviderBrokerRouteGrantSignatureV2 } from '@/app/machines/peer/mediation/signProviderBrokerRouteGrantV1';
import { readProvidersFeatureEnv } from '@/app/features/catalog/readFeatureEnv';
import { admitResponse } from '@/app/api/utils/enableSchemaValidation';
import { reportBrokerAdmissionFailure } from '@/app/providers/brokerRefusalDiagnostic';
import { PluginInstallationPublisherProofError, verifyPluginInstallationPublisherHeader } from '@/app/plugins/installations/publisherProof';
import { openTeamCredentialWatcherBroker, refreshTeamCredentialWatcherBroker } from './providerBrokerWatcherOpen';

export function registerTeamCredentialProviderBrokerRoutes(app: Fastify, personalApp: Fastify = app): void {
    const resolveExecutionRunCurrentness = createExecutionRunBrokerCurrentnessResolver({
        app,
        resolveServerIdentityId: () => getOrCreateServerIdentityId(process.env),
        createNonce: () => crypto.randomUUID(),
    });
    const readAccountConnectionPresence: Parameters<typeof openAccountConnectionProviderBroker>[0]['readCurrentPresence'] = async input => {
        if (input.initiatorAccountId === input.targetAccountId) {
            const presence = await getMachineDaemonPresenceInventory({ accountId: input.targetAccountId, io: app.machineDaemonPresence,
                machineIds: [input.initiatorMachineId, input.targetMachineId] });
            return { initiatorPresence: presence, targetPresence: presence };
        }
        const [initiatorPresence, targetPresence] = await Promise.all([
            getMachineDaemonPresenceInventory({ accountId: input.initiatorAccountId, io: app.machineDaemonPresence,
                machineIds: [input.initiatorMachineId] }),
            getMachineDaemonPresenceInventory({ accountId: input.targetAccountId, io: app.machineDaemonPresence,
                machineIds: [input.targetMachineId] }),
        ]);
        return { initiatorPresence, targetPresence };
    };
    personalApp.post(PROVIDER_BROKER_ACCOUNT_OPEN_HTTP_PATH_V2, {
        preHandler: app.authenticate, attachValidation: true,
        config: { restrictedCredentialBinding: { scope: 'session', session: 'body.consumer.sessionId', machine: 'body.initiatorMachineId' } },
        schema: { body: ProviderBrokerAccountOpenRequestV2Schema, response: {
            200: ProviderBrokerAccountOpenResponseV2Schema, 400: ProviderBrokerAccountOpenResponseV2Schema,
        } },
    }, async (request, reply) => {
        const parsed = ProviderBrokerAccountOpenRequestV2Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ ok: false, reasonCode: 'invalid_request' });
        const env = await readRequestHomeEnv(request);
        if (!readProvidersFeatureEnv(env).enabled) return reply.send(reportBrokerAdmissionFailure('account_open',
            { ok: false, reasonCode: 'resource_unavailable', refusalReason: 'providers_disabled' }));
        const signing = resolvePeerMediationGrantSigningConfig(env);
        if (!signing.ok) return reply.send(reportBrokerAdmissionFailure('account_open',
            { ok: false, reasonCode: 'update_required', refusalReason: signing.reasonCode }));
        // Restricted Runner credentials have a different activation/selection
        // authority. They cannot impersonate an ordinary Account connection.
        if (request.sessionRuntimePrincipal) return reply.send(reportBrokerAdmissionFailure('account_open',
            { ok: false, reasonCode: 'update_required', refusalReason: 'restricted_runner_principal' }));
        const result = await openAccountConnectionProviderBroker({
            actorAccountId: request.userId, homeId: await getOrCreateServerIdentityId(process.env),
            readCurrentPresence: readAccountConnectionPresence,
            request: parsed.data, tokenEpoch: readSessionAccessAuthenticationFromRequest(request).tokenEpoch,
            nowMs: Date.now(), grantId: crypto.randomUUID(),
            signingKey: { keyId: signing.keyId, secretKey: signing.secretKey }, resolveExecutionRunCurrentness,
            verifyRefreshAuthority: authority => verifyProviderBrokerRouteGrantSignatureV2({
                authority, signingCapability: signing.capability, nowMs: Date.now(),
            }),
        });
        return reply.send(ProviderBrokerAccountOpenResponseV2Schema.parse(result));
    });
    personalApp.post(PROVIDER_BROKER_ACCOUNT_ADMIT_HTTP_PATH_V2, {
        preHandler: app.authenticate, attachValidation: true,
        schema: { body: ProviderBrokerAccountAdmissionV2Schema, response: {
            200: ProviderBrokerAccountAdmissionResponseV2Schema, 400: ProviderBrokerAccountAdmissionResponseV2Schema,
        } },
    }, async (request, reply) => {
        const parsed = ProviderBrokerAccountAdmissionV2Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ ok: false, reasonCode: 'invalid_request' });
        const env = await readRequestHomeEnv(request);
        if (!readProvidersFeatureEnv(env).enabled) return reply.send(reportBrokerAdmissionFailure('account_admit',
            { ok: false, reasonCode: 'resource_unavailable', refusalReason: 'providers_disabled' }));
        const signing = resolvePeerMediationGrantSigningConfig(env);
        if (!signing.ok) return reply.send(reportBrokerAdmissionFailure('account_admit',
            { ok: false, reasonCode: 'update_required', refusalReason: signing.reasonCode }));
        const result = await admitAccountConnectionProviderBroker({
            actorAccountId: request.userId, homeId: await getOrCreateServerIdentityId(process.env),
            readCurrentPresence: readAccountConnectionPresence,
            request: parsed.data, resolveExecutionRunCurrentness,
            verifyAuthority: authority => verifyProviderBrokerRouteGrantSignatureV2({
                authority, signingCapability: signing.capability, nowMs: Date.now(),
            }),
        });
        return reply.send(ProviderBrokerAccountAdmissionResponseV2Schema.parse(result));
    });
    const modelCatalogAuthorizationSchema = z.union([ProviderBrokerModelCatalogAuthorizationV1Schema,
        TeamCredentialExternalProviderModelCatalogAuthorizationV1Schema]);
    app.post(PROVIDER_BROKER_MODEL_CATALOG_AUTHORIZE_HTTP_PATH_V1, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: modelCatalogAuthorizationSchema,
            response: {
                200: ProviderBrokerModelCatalogAuthorizationResponseV1Schema,
                400: ProviderBrokerModelCatalogAuthorizationResponseV1Schema,
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const parsed = modelCatalogAuthorizationSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ ok: false, reasonCode: 'invalid_request' });
        const external = TeamCredentialExternalProviderModelCatalogAuthorizationV1Schema.safeParse(parsed.data);
        if (external.success) {
            const result = await inTx(tx => authorizeTeamCredentialExternalProviderModelCatalogInTx(tx, {
                authenticatedBrokerAccountId: request.userId,
                request: external.data,
                observedAt: new Date(),
            }), { isolationLevel: "Serializable" /* External model disclosure composes key authority, entitlement and resource currentness. */ });
            return reply.send(admitResponse(ProviderBrokerModelCatalogAuthorizationResponseV1Schema, result));
        }
        const broker = ProviderBrokerModelCatalogAuthorizationV1Schema.parse(parsed.data);
        const signing = resolvePeerMediationGrantSigningConfig(requestHomeEnv);
        if (!signing.ok) return reply.send(reportBrokerAdmissionFailure('catalog',
            { ok: false, reasonCode: 'update_required', refusalReason: signing.reasonCode }));
        const result = await authorizeTeamCredentialProviderModelCatalog({
            authenticatedBrokerAccountId: request.userId,
            authority: broker.authority,
            expectedResourceRevision: broker.expectedResourceRevision,
            verifyAuthority: authority => verifyProviderBrokerRouteGrantSignatureV1({
                authority,
                signingCapability: signing.capability,
                nowMs: Date.now(),
            }),
            resolveExecutionRunCurrentness,
        });
        return reply.send(admitResponse(ProviderBrokerModelCatalogAuthorizationResponseV1Schema, result));
    });
    app.post(TEAM_CREDENTIAL_RESOURCE_TEST_ADMISSION_HTTP_PATH_V1, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamCredentialResourceTestAdmissionV1Schema,
            response: { 200: TeamCredentialResourceTestAdmissionResponseV1Schema, 400: TeamCredentialResourceTestAdmissionResponseV1Schema },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const parsed = TeamCredentialResourceTestAdmissionV1Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ ok: false, reasonCode: 'invalid_request' });
        const relaySigning = resolvePeerMediationGrantSigningConfig(requestHomeEnv);
        if (!relaySigning.ok) return reply.send(reportBrokerAdmissionFailure('resource_test',
            { ok: false, reasonCode: 'invalid_request', refusalReason: relaySigning.reasonCode }));
        const result = await inTx(tx => admitTeamCredentialResourceTestRequestInTx(tx, {
            authenticatedBrokerAccountId: request.userId,
            request: parsed.data,
            observedAt: new Date(),
            relayAuthorizationTrustRoots: [{
                keyId: relaySigning.capability.keyId,
                publicKeyBase64Url: relaySigning.capability.publicKey,
                expiresAt: relaySigning.capability.expiresAt,
            }],
        }), { isolationLevel: "ReadCommitted" /* Admission reads recorded period spend; in-flight requests may overlap. */ });
        return reply.send(admitResponse(TeamCredentialResourceTestAdmissionResponseV1Schema, result));
    });
    app.post(TEAM_CREDENTIAL_EXTERNAL_PROVIDER_ADMISSION_HTTP_PATH_V1, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamCredentialExternalProviderAdmissionV1Schema,
            response: { 200: TeamCredentialExternalProviderAdmissionResponseV1Schema, 400: TeamCredentialExternalProviderAdmissionResponseV1Schema },
        },
    }, async (request, reply) => {
        const parsed = TeamCredentialExternalProviderAdmissionV1Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ ok: false, reasonCode: 'invalid_request' });
        const result = await inTx(tx => admitTeamCredentialExternalProviderRequestInTx(tx, {
            authenticatedBrokerAccountId: request.userId,
            request: parsed.data,
            observedAt: new Date(),
        }), { isolationLevel: "ReadCommitted" /* Admission reads recorded period spend; in-flight requests may overlap. */ });
        return reply.send(admitResponse(TeamCredentialExternalProviderAdmissionResponseV1Schema, result));
    });
    app.post(TEAM_CREDENTIAL_EXTERNAL_PROVIDER_TERMINAL_USAGE_HTTP_PATH_V1, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: TeamCredentialExternalProviderTerminalUsageV1Schema,
            response: {
                200: TeamCredentialExternalProviderTerminalUsageResponseV1Schema,
                400: TeamCredentialExternalProviderTerminalUsageResponseV1Schema,
            },
        },
    }, async (request, reply) => {
        const parsed = TeamCredentialExternalProviderTerminalUsageV1Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ ok: false, reasonCode: 'invalid_request' });
        const result = await inTx(tx => recordTeamCredentialExternalProviderTerminalUsageInTx(tx, {
            authenticatedBrokerAccountId: request.userId,
            request: parsed.data,
        }), { isolationLevel: "Serializable" /* Terminal observation replay remains in its existing write family. */ });
        return reply.send(admitResponse(TeamCredentialExternalProviderTerminalUsageResponseV1Schema, result));
    });
    const brokerOpenSchema = z.union([ProviderBrokerOpenRequestV1Schema, ProviderBrokerActionOpenRequestV3Schema, ProviderBrokerWatcherOpenRequestV1Schema, ProviderBrokerWatcherRefreshRequestV1Schema]);
    const brokerOpenResponseSchema = z.union([ProviderBrokerOpenResponseV1Schema, ProviderBrokerActionOpenResponseV3Schema, ProviderBrokerWatcherOpenResponseV1Schema, ProviderBrokerWatcherRefreshResponseV1Schema]);
    const brokerAdmissionSchema = z.union([ProviderBrokerRequestAdmissionV1Schema, ProviderBrokerActionAdmissionV3Schema]);
    const brokerAdmissionResponseSchema = z.union([ProviderBrokerRequestAdmissionResponseV1Schema, ProviderBrokerActionAdmissionResponseV3Schema]);
    app.post(PROVIDER_BROKER_OPEN_HTTP_PATH_V1, {
        preHandler: app.authenticate,
        config: {
            restrictedCredentialBinding: {
                scope: 'session',
                session: 'body.consumer.sessionId',
                machine: 'body.initiatorMachineId',
            },
        },
        attachValidation: true,
        schema: {
            body: brokerOpenSchema,
            response: { 200: brokerOpenResponseSchema, 400: brokerOpenResponseSchema },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const parsed = brokerOpenSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ ok: false, reasonCode: 'invalid_request' });
        }
        const signing = resolvePeerMediationGrantSigningConfig(requestHomeEnv);
        if (!signing.ok) return reply.send(reportBrokerAdmissionFailure('open',
            { ok: false, reasonCode: 'update_required', refusalReason: signing.reasonCode }));
        const sessionRuntimePrincipal = request.sessionRuntimePrincipal;
        const openRequest = parsed.data;
        if (sessionRuntimePrincipal && openRequest.v !== 3 && !('scope' in openRequest)) {
            const runnerSelection = await inTx(tx => verifyRunnerBrokerOpenSelectionInTx(tx, {
                principal: sessionRuntimePrincipal,
                request: openRequest,
            }), { isolationLevel: "Serializable" /* Runner broker selection verification composes frozen selection, entitlement and resource currentness. */ });
            if (!runnerSelection) {
                return reply.send({ ok: false, reasonCode: 'resource_forbidden' });
            }
        }
        const readCurrentPresence: TeamCredentialProviderBrokerOpenInput['readCurrentPresence'] = async presence => {
            const [currentInitiatorPresence, currentBrokerPresence] = await Promise.all([
                getMachineDaemonPresenceInventory({
                    accountId: presence.initiatorAccountId,
                    io: app.machineDaemonPresence,
                    machineIds: [presence.initiatorMachineId],
                }),
                getMachineDaemonPresenceInventory({
                    accountId: presence.brokerAccountId,
                    io: app.machineDaemonPresence,
                    machineIds: presence.brokerMachineIds,
                }),
            ]);
            return {
                initiatorPresence: currentInitiatorPresence,
                brokerPresence: currentBrokerPresence,
            };
        };
        const eligibilityAbort = new AbortController();
        const abortEligibility = () => eligibilityAbort.abort(new Error('broker_open_client_closed'));
        request.raw.once('aborted', abortEligibility);
        reply.raw.once('close', abortEligibility);
        try {
        if ('scope' in openRequest) {
            reply.header('Cache-Control', 'no-store');
            if (sessionRuntimePrincipal || request.externalActionExecutionAuthorized || openRequest.caller.requesterOperation) {
                return reply.send({ ok: false, reasonCode: 'resource_forbidden' });
            }
            const publisher = await verifyPluginInstallationPublisherHeader({
                accountId: request.userId, request, path: PROVIDER_BROKER_OPEN_HTTP_PATH_V1, required: true,
            }).catch(error => {
                if (error instanceof PluginInstallationPublisherProofError) return null;
                throw error;
            });
            if (!publisher || publisher.machineId !== openRequest.initiatorMachineId
                || publisher.machineId !== openRequest.caller.materialization.machineId) {
                return reply.send({ ok: false, reasonCode: 'resource_forbidden' });
            }
            const watcherAdmission = {
                actorAccountId: request.userId,
                publisherInstallationId: publisher.installationId, serverIdentityId: await getOrCreateServerIdentityId(process.env),
                nowMs: Date.now(), grantId: crypto.randomUUID(),
                signingKey: { keyId: signing.keyId, secretKey: signing.secretKey }, signal: eligibilityAbort.signal,
            };
            if ('refreshAuthority' in openRequest) {
                const result = await refreshTeamCredentialWatcherBroker({
                    ...watcherAdmission, request: openRequest, signingCapability: signing.capability,
                });
                return reply.send(admitResponse(ProviderBrokerWatcherRefreshResponseV1Schema, result));
            }
            const result = await openTeamCredentialWatcherBroker({
                ...watcherAdmission, request: openRequest, readCurrentPresence,
                authentication: readSessionAccessAuthenticationFromRequest(request),
                readPoolSourceEligibility: createTeamCredentialPoolSourceEligibilityReader(app.forwardRpcForUser),
            });
            return reply.send(admitResponse(ProviderBrokerWatcherOpenResponseV1Schema, result));
        }
        if (openRequest.v === 3) {
            const admission = request.externalActionActionBrokerAdmission;
            if (!admission || admission.resourceId !== openRequest.resourceId
                || admission.machineId !== openRequest.initiatorMachineId) {
                return reply.send({ ok: false, reasonCode: 'resource_forbidden' });
            }
            const result = await openTeamCredentialActionBroker({
                actorAccountId: request.userId, rootActionId: admission.rootActionId,
                ...(admission.admittedReviewedChildActionId ? { admittedReviewedChildActionId: admission.admittedReviewedChildActionId } : {}),
                authentication: readSessionAccessAuthenticationFromRequest(request), request: openRequest,
                readCurrentPresence, readPoolSourceEligibility: createTeamCredentialPoolSourceEligibilityReader(app.forwardRpcForUser),
                nowMs: Date.now(), grantId: crypto.randomUUID(),
                signingKey: { keyId: signing.keyId, secretKey: signing.secretKey }, signal: eligibilityAbort.signal,
            });
            return reply.send(admitResponse(ProviderBrokerActionOpenResponseV3Schema, result));
        }
        const openInput: TeamCredentialProviderBrokerOpenInput = {
            actorAccountId: request.userId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
            request: openRequest,
            readCurrentPresence,
            nowMs: Date.now(),
            grantId: crypto.randomUUID(),
            signingKey: { keyId: signing.keyId, secretKey: signing.secretKey },
            verifyRefreshAuthority: authority => verifyProviderBrokerRouteGrantSignatureV1({
                authority,
                signingCapability: signing.capability,
                nowMs: Date.now(),
            }),
            signal: eligibilityAbort.signal,
            readPoolSourceEligibility: createTeamCredentialPoolSourceEligibilityReader(app.forwardRpcForUser),
            resolveExecutionRunCurrentness,
            readProviderProjection: async projection => {
                const rpcResult = await app.forwardRpcForUser({
                    userId: projection.custodianAccountId,
                    method: `${projection.brokerMachineId}:${RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION}`,
                    params: {
                        machineId: projection.brokerMachineId,
                        agentTargetKey: projection.agentTargetKey,
                        application: projection.application,
                        sourceCatalog: true,
                        ...(projection.source.kind === 'provider_connection'
                            ? { providerConnection: {
                                connectionId: projection.source.connectionId,
                                expectedConnectionSecurityFingerprint: projection.source.connectionSecurityFingerprint,
                            } }
                            : { connectedAccountTarget: projection.source.target }),
                    },
                });
                if (!rpcResult.ok) throw new Error('Provider projection unavailable');
                return rpcResult.result;
            },
        };
        const result = await (request.sessionRuntimePrincipal
            ? openRunnerTeamCredentialProviderBroker({
                ...openInput,
                principal: request.sessionRuntimePrincipal!,
            })
            : openTeamCredentialProviderBroker(openInput));
        return reply.send(admitResponse(ProviderBrokerOpenResponseV1Schema, result));
        } finally {
            request.raw.off('aborted', abortEligibility);
            reply.raw.off('close', abortEligibility);
        }
    });

    app.post(PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1, {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: brokerAdmissionSchema,
            response: { 200: brokerAdmissionResponseSchema, 400: brokerAdmissionResponseSchema },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const parsed = brokerAdmissionSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ ok: false, reasonCode: 'invalid_request' });
        }
        const signing = resolvePeerMediationGrantSigningConfig(requestHomeEnv);
        if (!signing.ok) return reply.send(reportBrokerAdmissionFailure('request',
            { ok: false, reasonCode: 'update_required', refusalReason: signing.reasonCode }));
        const observedAt = new Date();
        if (parsed.data.v === 3) {
            const result = await admitTeamCredentialActionBrokerRequest({ authenticatedBrokerAccountId: request.userId,
                request: parsed.data, verifyAuthority: authority => verifyProviderBrokerActionRouteGrantSignatureV3({
                    authority, signingCapability: signing.capability, nowMs: observedAt.getTime(),
                }) });
            return reply.send(admitResponse(ProviderBrokerActionAdmissionResponseV3Schema, result));
        }
        const result = await admitTeamCredentialProviderBrokerRequest({
            authenticatedBrokerAccountId: request.userId,
            request: parsed.data,
            observedAt,
            verifyAuthority: authority => verifyProviderBrokerRouteGrantSignatureV1({
                authority,
                signingCapability: signing.capability,
                nowMs: observedAt.getTime(),
            }),
            resolveExecutionRunCurrentness,
        });
        return reply.send(admitResponse(ProviderBrokerRequestAdmissionResponseV1Schema, result));
    });
}
