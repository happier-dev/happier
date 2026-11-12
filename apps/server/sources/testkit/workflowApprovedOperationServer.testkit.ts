import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import { Server } from 'socket.io';
import { ExternalActionDaemonDispatchRequestSchema, type ExternalActionDaemonDispatchRequest } from '@happier-dev/protocol/actions/externalActionApi';
import { createExternalActionDaemonDispatcher, type ExternalActionForwardRpcCall } from '@/app/api/socket/externalActionDispatcher';
import { forwardRpcCall, type RpcForwardResult } from '@/app/api/socket/rpc/forwardRpcCall';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainArtifactStoredContent,
    decodePlainMachineStoredContent, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER,
    MachineSetupDesiredV1Schema, type MachineSetupDesiredV1 } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { registerWorkflowRunStorageRoutes } from '@/app/api/routes/automations/registerWorkflowRunStorageRoutes';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerAccountProfileRoute } from '@/app/api/routes/account/registerAccountProfileRoute';
import { registerAccountSettingsRoutes } from '@/app/api/routes/account/registerAccountSettingsRoutes';
import { registerProjectAccountRowRoutes } from '@/app/api/routes/projects/registerProjectAccountRowRoutes';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { mutateProjectAccountRows } from '@/app/projects/projectAccountRowService';
import { ProjectAccountRowMutationRequestV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { DeploymentPrepareInputV1 } from '@happier-dev/protocol';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { projectSourceRoutes } from '@/app/api/routes/projects/projectSourceRoutes';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { startSocket } from '@/app/api/socket';
import { featuresRoutes } from '@/app/api/routes/features/featuresRoutes';
import { getOrCreateServerIdentityId, readCachedServerIdentityIdForHotPath } from '@/app/serverIdentity/serverIdentity';
import { automationAccountCurrentnessSelect, deriveAutomationAccountCurrentnessWitness } from '@/app/automations/automationAccountCurrentness';
import { createSignedPluginInstallationPublisherHeader } from './pluginInstallationPublisherTestkit';
import { createLightSqliteHarness } from './lightSqliteHarness';
import { claimAutomationRun, toAutomationV3WorkerClaimResponse } from '@/app/automations/automationClaimService';
import { accountRoutes } from '@/app/api/routes/account/accountRoutes';
import { authRoutes } from '@/app/api/routes/auth/authRoutes';
import { automationRoutes } from '@/app/api/routes/automations/automationRoutes';
import { sessionRoutes } from '@/app/api/routes/session/sessionRoutes';
import { sessionPendingRoutes } from '@/app/api/routes/session/pendingRoutes';
import { accessKeysRoutes } from '@/app/api/routes/accessKeys/accessKeysRoutes';
import { changesRoutes } from '@/app/api/routes/changes/changesRoutes';
import { buildRpcMethodRoom } from '@/app/api/socket/rpc/rpcMethodRoom';
import type { MachineInstallationIdentityV1 } from '@happier-dev/protocol';
import { setMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createSignedAccountContentBinding } from './accountEncryption';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { registerPromptLibraryRoutes } from '@/app/account/prompts/registerPromptLibraryRoutes';
import { registerAccountPublicProfileRoutes } from '@/app/api/routes/account/registerAccountPublicProfileRoutes';
import { registerQualifiedConnectedAccountCredentialRoutesV4 } from '@/app/api/routes/connect/qualifiedConnectedAccounts/registerQualifiedConnectedAccountCredentialRoutesV4';
import { registerPluginAvailabilityRoutes } from '@/app/plugins/availability/routes';
import { registerTeamCredentialResourceRoutes } from '@/app/teams/credentials/registerTeamCredentialResourceRoutes';
import { homeGovernanceRoutes } from '@/app/api/routes/home/homeGovernanceRoutes';
import { pluginDataRoutes } from '@/app/api/routes/plugins/data/pluginDataRoutes';
import { kvRoutes } from '@/app/api/routes/kv/kvRoutes';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';

type WorkflowApprovedOperationReceiverTransport = Readonly<{
    request: Parameters<ExternalActionForwardRpcCall>[0];
    /** Use the actual registered Home socket, including its exact-target guard. */
    forward: () => Promise<RpcForwardResult>;
}>;
type WorkflowApprovedOperationReceiver = (request: ExternalActionDaemonDispatchRequest, signal?: AbortSignal,
    transport?: WorkflowApprovedOperationReceiverTransport) => Promise<unknown>;

/** Real HTTP/storage/auth boundary for cross-app Workflow admission tests. */
export async function startWorkflowApprovedOperationServer(input: Readonly<{
    /** Cross-owner Session-step tests retain the ordinary HTTP Session owners. */
    workflowSessions?: boolean;
    /** Substitute the daemon socket boundary, including managed controller RPCs. */
    forwardRpc?: ExternalActionForwardRpcCall;
    /** Full daemon journeys use actual sockets and the ordinary Home owners. */
    installedMachine?: Readonly<{ machineId: string; installation: MachineInstallationIdentityV1; happyHomeDir: string }>;
    deploymentTeamOwned?: boolean;
    /** The owning client supplies codecs; Home stores only opaque Machine content. */
    e2ee?: Readonly<{ contentPublicKey: Uint8Array;
        encodeMachine(key: Uint8Array, value: unknown): string;
        decodeMachine(key: Uint8Array, value: string): unknown }>;
}> = {}) {
    // These isolated databases share a process with the real Home identity
    // owner. A later fixture must retain its already initialized identity.
    const homeIdentityId = readCachedServerIdentityIdForHotPath() ?? `srv_${randomUUID().replaceAll('-', '')}`;
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'workflow-approved-operation-', initAuth: true, initEncrypt: true,
        env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_SERVER_IDENTITY_ID: homeIdentityId,
            HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    const app = Fastify({ logger: false, bodyLimit: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 }).withTypeProvider<ZodTypeProvider>();
    // Observe the real HTTP/authentication owners without substituting their decisions.
    let costPhase = 'fixture';
    const requestCosts: Array<{ phase: string; method: string; route: string; admissions: number; status: number | null }> = [];
    const requestCostById = new Map<string, (typeof requestCosts)[number]>();
    app.addHook('onRequest', async request => {
        const cost = { phase: costPhase, method: request.method, route: request.routeOptions.url ?? 'unmatched', admissions: 0, status: null as number | null };
        requestCosts.push(cost);
        requestCostById.set(request.id, cost);
    });
    app.addHook('onResponse', async (request, reply) => {
        const cost = requestCostById.get(request.id);
        if (cost) cost.status = reply.statusCode;
        requestCostById.delete(request.id);
    });
    const receivers = new Map<string, WorkflowApprovedOperationReceiver>();
    const close = async () => {
        try {
            // startSocket publishes this fixture's mounted Socket.IO owner here.
            // Its process-shutdown hook is not invoked by Fastify.close().
            const io = app.machineDaemonPresence;
            if (io instanceof Server) {
                await io.close();
            }
        } finally {
            try {
                await app.close();
            } finally {
                await harness.close();
            }
        }
    };
    try {
        enableSchemaValidation(app);
        enableErrorHandlers(app);
        enableAuthentication(app);
        const authenticate = app.authenticate;
        app.authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
            const cost = requestCostById.get(request.id);
            if (cost) cost.admissions++;
            return authenticate.call(app, request, reply);
        };
        if (input.installedMachine || input.workflowSessions) {
            authRoutes(app);
            accountRoutes(app);
            automationRoutes(app);
            sessionRoutes(app);
            sessionPendingRoutes(app);
            accessKeysRoutes(app);
            changesRoutes(app);
            registerAccountPublicProfileRoutes(app);
            registerQualifiedConnectedAccountCredentialRoutesV4(app);
            registerPluginAvailabilityRoutes(app);
            registerTeamCredentialResourceRoutes(app);
            homeGovernanceRoutes(app);
            pluginDataRoutes(app);
            kvRoutes(app);
        } else {
            registerWorkflowRunStorageRoutes(app);
            registerAccountEncryptionRoutes(app);
            registerAccountProfileRoute(app);
            registerAccountSettingsRoutes(app);
            registerProjectAccountRowRoutes(app);
            registerPromptLibraryRoutes(app);
        }
        machinesRoutes(app);
        registerDeploymentRoutes(app);
        projectSourceRoutes(app);
        artifactsRoutes(app);
        featuresRoutes(app);
        // Requester currentness is maintained by the real admitted user socket.
        // HTTP alone cannot establish the observer's connected authority.
        startSocket(app);
        // Only socket delivery is substituted. Home placement/mint/currentness
        // and each registered daemon's production RPC admission remain real.
        const machinePresence = app.machineDaemonPresence;
        if (!(machinePresence instanceof Server)) throw new Error('machine_daemon_presence_unavailable');
        if (input.installedMachine && !input.forwardRpc) registerExternalActionRoutes(app);
        else registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io: machinePresence,
            forwardRpc: input.forwardRpc ?? (async request => {
                const packet = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
                const receive = receivers.get(packet.placement.machineId);
                if (!receive) return { ok: false, error: 'target_unavailable' };
                try {
                    const delivery: { forwarded?: RpcForwardResult } = {};
                    const result = await receive(packet, request.cancellation?.signal, { request, forward: async () => {
                        const forwarded = await forwardRpcCall(request);
                        delivery.forwarded = forwarded;
                        return forwarded;
                    } });
                    return delivery.forwarded?.ok === false ? delivery.forwarded : { ok: true, result };
                } catch (error) {
                    // Delivery happened, but its acknowledgement did not. Match
                    // the real socket boundary's submitted-unknown contract.
                    request.onSubmittedUnknown?.();
                    throw error;
                }
            }) }) });
        const account = await db.account.create({ data: input.e2ee
            ? { ...createSignedAccountContentBinding(input.e2ee.contentPublicKey), encryptionMode: 'e2ee' }
            : { publicKey: null, encryptionMode: 'plain' } });
        const deploymentTeam = input.deploymentTeamOwned
            ? await db.team.create({ data: { name: 'Publish deployment admission' } }) : null;
        if (deploymentTeam) await db.teamMembership.create({ data: {
            teamId: deploymentTeam.id, accountId: account.id, role: 'owner',
        } });
        const machines = await Promise.all((input.installedMachine ? ['installed'] : ['parent', 'first', 'second']).map(async name => {
            const installed = input.installedMachine;
            const keys = installed ? { publicKey: decodeBase64(installed.installation.publicKey, 'base64url'),
                secretKey: decodeBase64(installed.installation.privateKey, 'base64url') } : tweetnacl.sign.keyPair();
            const contentKey = input.e2ee ? tweetnacl.randomBytes(32) : null;
            const metadata = { host: name, platform: 'linux', happyCliVersion: 'test',
                    homeDir: installed?.happyHomeDir ?? '/users/worker', happyHomeDir: installed?.happyHomeDir ?? '/users/worker/.happier',
                    ...(installed ? { agentIsolation: { enabled: false } } : {}) };
            const machine = await db.machine.create({ data: { id: installed?.machineId ?? randomUUID(), accountId: account.id,
                metadata: contentKey && input.e2ee ? input.e2ee.encodeMachine(contentKey, metadata) : encodePlainMachineStoredContent(metadata),
                dataEncryptionKey: contentKey && input.e2ee ? Uint8Array.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: contentKey,
                    recipientPublicKey: input.e2ee.contentPublicKey, randomBytes: tweetnacl.randomBytes }))
                    : Uint8Array.from(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)), active: true,
                operationProtocolCapabilitiesRevision: 1,
                operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } },
                installationId: installed?.installation.installationId ?? randomUUID(), installationPublicKey: Uint8Array.from(keys.publicKey) } });
            return { id: machine.id, installationId: machine.installationId!, keys, contentKey };
        }));
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        if (deploymentTeam) await db.machineTeamGrant.createMany({ data: machines.map(machine => ({
            machineId: machine.id, teamId: deploymentTeam.id, accessLevel: 'view' as const, createdByAccountId: account.id,
        })) });
        const installedToken = input.installedMachine
            ? await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' }) : null;
        const currentness = deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({
            where: { id: account.id }, select: automationAccountCurrentnessSelect }));
        const homeId = await getOrCreateServerIdentityId();
        const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        const createDeploymentProjectSource = async () => {
            const result = await inTx(tx => createProjectSourceInTx(tx, account.id, {
                serverId: homeId, requestKey: randomUUID(), name: 'Publish host defaults', audience: [],
                ...(deploymentTeam ? { owner: { kind: 'team' as const, teamId: deploymentTeam.id } } : {}),
                repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'acme/publish-host', cloneUrl: 'https://github.com/acme/publish-host.git' }, protocol: 'https' },
            }));
            if (!result.ok) throw new Error(result.error);
            return result.source;
        };
        return {
            accountId: account.id, tokenEpoch: account.tokenEpoch, token, installedToken, homeId, baseUrl, currentness, machines,
            setCostPhase: (phase: string) => { costPhase = phase; },
            readRequestCosts: () => requestCosts.map(cost => ({ ...cost })),
            waitForMachineRpc: async (machineId: string, method: string, signal?: AbortSignal) => {
                const io = app.machineDaemonPresence;
                if (!(io instanceof Server)) throw new Error('Workflow Home socket owner unavailable');
                const room = buildRpcMethodRoom({ userId: account.id, method: `${machineId}:${method}` });
                const adapter = io.sockets.adapter;
                if (adapter.rooms.get(room)?.size) return;
                await new Promise<void>((resolve, reject) => {
                    const cleanup = () => { adapter.off('join-room', joined); signal?.removeEventListener('abort', aborted); };
                    const joined = (value: string) => { if (value === room) { cleanup(); resolve(); } };
                    const aborted = () => { cleanup(); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
                    adapter.on('join-room', joined);
                    signal?.addEventListener('abort', aborted, { once: true });
                    if (signal?.aborted) aborted();
                    else if (adapter.rooms.get(room)?.size) { cleanup(); resolve(); }
                });
            },
            createMachineMember: async (accessLevel: 'view' | 'admin') => {
                const member = await db.account.create({ data: { encryptionMode: 'plain' } });
                const machine = input.installedMachine;
                if (!machine) throw new Error('Installed Machine required for Workflow member');
                await makeShareEligibleForTest(account.id, member.id);
                const grant = await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: account.id,
                    machineId: machine.machineId, principal: { kind: 'account', accountId: member.id }, level: accessLevel }));
                if (grant.kind !== 'saved') throw new Error('Workflow member grant unavailable');
                return { accountId: member.id,
                    token: await auth.createToken(member.id, undefined, { kind: 'account', authority: 'present_user' }) };
            },
            createForeignAccount: async () => {
                const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
                return { accountId: foreign.id,
                    token: await auth.createToken(foreign.id, undefined, { kind: 'account', authority: 'present_user' }) };
            },
            readWorkflowSessionEffects: async () => ({
                sessions: await db.session.findMany({ where: { accountId: account.id },
                    select: { id: true, metadata: true, pendingCount: true, pendingBlockedCount: true } }),
                messages: await db.sessionMessage.findMany({ where: { session: { accountId: account.id } },
                    orderBy: [{ sessionId: 'asc' }, { seq: 'asc' }], select: { id: true, sessionId: true, localId: true, seq: true, messageRole: true, content: true } }),
                pending: await db.sessionPendingMessage.findMany({ where: { session: { accountId: account.id } },
                    select: { sessionId: true, localId: true } }),
                turns: await db.sessionTurn.findMany({ where: { session: { accountId: account.id } },
                    select: { sessionId: true, turnId: true, status: true, transcriptAnchorsJson: true } }),
                runs: await db.automationRun.findMany({ select: { id: true, accountId: true, state: true } }),
            }),
            createPrepareWorkspace: async (input: Readonly<{ rootPath: string; machineId: string; baseCommit: string }>): Promise<DeploymentPrepareInputV1> => {
                const source = await inTx(tx => createProjectSourceInTx(tx, account.id, {
                    serverId: homeId, requestKey: randomUUID(), name: 'Prepare workspace', audience: [],
                    repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                        repository: { nameWithOwner: 'prepare/app', cloneUrl: 'https://github.com/prepare/app.git' }, protocol: 'https' },
                }));
                if (!source.ok) throw new Error(source.error);
                const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'prepare/app' };
                const key = { kind: 'workspace-ref' as const, serverId: homeId, id: randomUUID() };
                const graphKey = { kind: 'relationship-graph' as const };
                const result = await mutateProjectAccountRows({ accountId: account.id,
                    request: ProjectAccountRowMutationRequestV1Schema.parse({ topologyChange: true, expectedRefs: [], mutations: [
                        { key, expectedRevision: 'absent', content: { t: 'plain', v: { key, value: {
                            id: key.id, serverId: homeId, machineId: input.machineId, rootPath: input.rootPath, createdAtMs: 1,
                            source: { sourceId: source.source.id, revision: source.source.revision }, repositoryIdentity: repository,
                        } } } },
                        { key: graphKey, expectedRevision: 'absent', content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } },
                    ] }) });
                if (result.status !== 'updated') throw new Error(`prepare_workspace_${result.status}`);
                return { projectSourceId: source.source.id, sourceRevision: source.source.revision,
                    repository, baseCommit: input.baseCommit, workspace: key };
            },
            createDeploymentArtifact: async (input: Readonly<{ header: Readonly<Record<string, unknown>>; body: string }>) => {
                const created = await createArtifact({ actorUserId: account.id, artifactId: randomUUID(),
                    header: decodeBase64(encodePlainArtifactStoredContent(input.header)),
                    body: decodeBase64(encodePlainArtifactStoredContent({ body: input.body })),
                    dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
                if (!created.ok) throw new Error(created.error);
                if (deploymentTeam) await db.artifactTeamGrant.create({ data: {
                    artifactId: created.artifact.id, teamId: deploymentTeam.id, accessLevel: 'admin', createdByAccountId: account.id,
                } });
                return { contentArtifactId: created.artifact.id, contentHeaderVersion: created.artifact.headerVersion,
                    contentBodyVersion: created.artifact.bodyVersion };
            },
            createDeploymentProject: async () => {
                const source = await createDeploymentProjectSource();
                const content = async (kind: string) => {
                    const created = await createArtifact({ actorUserId: account.id, artifactId: randomUUID(),
                        header: decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Publish host fixture' })),
                        body: decodeBase64(encodePlainArtifactStoredContent({ name: 'Staging' })),
                        dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
                    if (!created.ok) throw new Error(created.error);
                    if (deploymentTeam) await db.artifactTeamGrant.create({ data: {
                        artifactId: created.artifact.id, teamId: deploymentTeam.id, accessLevel: 'admin', createdByAccountId: account.id,
                    } });
                    return { contentArtifactId: created.artifact.id, contentHeaderVersion: created.artifact.headerVersion,
                        contentBodyVersion: created.artifact.bodyVersion };
                };
                return { projectSourceId: source.id, audience: source.audience,
                    environmentContent: await content('deployment-environment.v1'),
                    runtimeContent: await content('deployment-target-link.v1') };
            },
            createDeploymentProjectSource: async () => {
                const source = await createDeploymentProjectSource();
                return { projectSourceId: source.id, audience: source.audience };
            },
            setReceiver: (machineId: string, receive: WorkflowApprovedOperationReceiver) => {
                receivers.set(machineId, receive);
            },
            demoteDeploymentCaller: async () => {
                if (!deploymentTeam) throw new Error('team_deployment_fixture_required');
                const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
                await db.teamMembership.create({ data: { teamId: deploymentTeam.id, accountId: owner.id, role: 'owner' } });
                await db.teamMembership.update({ where: { teamId_accountId: {
                    teamId: deploymentTeam.id, accountId: account.id,
                } }, data: { role: 'member' } });
            },
            readDeploymentEffects: (environmentId: string) => db.deployment.findMany({
                where: { environmentId }, orderBy: { id: 'asc' },
                select: { id: true, requestedByAccountId: true, state: true, contentArtifactId: true },
            }),
            publisherHeader: (input: { machineId: string; path: string; body: unknown }) => {
                const machine = machines.find(item => item.id === input.machineId);
                if (!machine) throw new Error('unknown_test_publisher');
                return createSignedPluginInstallationPublisherHeader({ keyPair: machine.keys, machineId: machine.id,
                    installationId: machine.installationId, path: input.path, body: input.body, nonce: randomUUID() });
            },
            claim: async (machineId: string) => {
                const result = await claimAutomationRun({ accountId: account.id, machineId, leaseDurationMs: 30_000, scope: 'workflow' });
                if (!result.run) throw new Error('workflow_test_claim_unavailable');
                const claimed = toAutomationV3WorkerClaimResponse(result).run;
                return { runId: result.run.id, attempt: result.run.attempt, revision: result.run.revision,
                    ...(claimed?.workflowResumeRequestedRevision === undefined ? {}
                        : { workflowResumeRequestedRevision: claimed.workflowResumeRequestedRevision }) };
            },
            revokeAccount: async () => { await db.account.update({ where: { id: account.id }, data: { tokenEpoch: { increment: 1 } } }); },
            setMachineOnline: async (machineId: string, active: boolean) => { await db.machine.update({ where: { id: machineId }, data: { active } }); },
            seedMachineSetupDesired: async (machineId: string, desired: MachineSetupDesiredV1) => {
                const machine = machines.find(machine => machine.id === machineId);
                if (!machine) throw new Error('unknown_fixture_machine');
                const setup = MachineSetupDesiredV1Schema.parse(desired);
                const row = await db.machine.findFirstOrThrow({ where: { id: machineId, accountId: account.id }, select: { metadata: true } });
                const metadata = machine.contentKey && input.e2ee ? input.e2ee.decodeMachine(machine.contentKey, row.metadata)
                    : decodePlainMachineStoredContent(row.metadata);
                if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('fixture_machine_metadata_invalid');
                await db.machine.update({ where: { id: machineId }, data: {
                    metadata: machine.contentKey && input.e2ee ? input.e2ee.encodeMachine(machine.contentKey, { ...metadata, setup })
                        : encodePlainMachineStoredContent({ ...metadata, setup }), metadataVersion: { increment: 1 },
                } });
            },
            readMachines: async () => (await db.machine.findMany({ where: { id: { in: machines.map(machine => machine.id) } },
                select: { id: true, active: true } })).map(machine => ({ machineId: machine.id, online: machine.active })),
            close,
        };
    } catch (error) {
        await close();
        throw error;
    }
}
