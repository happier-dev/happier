import { API_TOKEN_FULL_GRANT_V1, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import {
    ExternalActionExecutionAuthorizationV1Schema,
    bindExternalActionExecutionAuthorizationHttpPathV1,
    computeExternalActionRequestEnvelopeDigestV1,
    encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1,
    type ExternalActionRequestEnvelopeV1,
} from '@happier-dev/protocol/actions';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { decodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth } from '@/app/auth/auth';
import { verifyExternalActionDomainExecutionRequest } from '@/app/auth/externalActionExecutionAuthorization';
import {
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
} from '@happier-dev/protocol/actions/externalActionApi';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { changesRoutes } from '@/app/api/routes/changes/changesRoutes';
import { featuresRoutes } from '@/app/api/routes/features/featuresRoutes';
import { sessionPendingRoutes } from '@/app/api/routes/session/pendingRoutes';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { registerSessionMessageRoutes } from '@/app/api/routes/session/registerSessionMessageRoutes';
import { registerSessionSystemRecordRoutes } from '@/app/api/routes/session/registerSessionSystemRecordRoutes';
import { registerSessionTurnMutationRoute } from '@/app/api/routes/session/registerSessionTurnMutationRoute';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { plainPrivateLabel } from '@/testkit/privateLabelFixture';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';

// The admitted read-root rule and the one foreign-custodian read rule, at the verifier owner.
let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: 'happier-admitted-read-root-',
        initAuth: true,
        env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0' },
    });
}, 120_000);
afterAll(async () => {
    await harness?.close();
});

async function createFixture() {
    const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
    const keyPair = tweetnacl.sign.keyPair();
    const machine = await db.machine.create({ data: {
        id: crypto.randomUUID(), accountId: account.id,
        metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }), metadataVersion: 1,
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'), daemonState: null, daemonStateVersion: 0,
        installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keyPair.publicKey),
    } });
    const pat = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: plainPrivateLabel('ordinary') });
    const envelope: ExternalActionRequestEnvelopeV1 = { v: 1, requestId: crypto.randomUUID(),
        target: { kind: 'machine', machineId: machine.id }, input: {} };
    return { account, machine, pat, envelope, keyPair };
}

function createApp(resolveCurrentSessionMachine: () => Promise<string | null>) {
    const app = Fastify().withTypeProvider<ZodTypeProvider>() as AppFastify;
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('resolveCurrentSessionMachine', resolveCurrentSessionMachine);
    enableAuthentication(app);
    registerExternalActionRoutes(app, { dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }) });
    return app;
}

describe('admitted read-root requester reads', () => {
    it('lets an admitted read-only Account root make its GET reads as the requester and nothing more', async () => {
        // DBW-TELEMETRY F14: the signed machines.roles.get root reads GET /v1/machines/<id>; the Machine
        // route keeps the requester's own access, so this equals the requester's bearer read.
        const fixture = await createFixture();
        // A Team member's Machine hosts one of the requester's Sessions under a shared-Machine grant.
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const hostKeys = tweetnacl.sign.keyPair();
        const host = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(hostKeys.publicKey) } });
        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: host.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const session = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: host.id, sessionId: session.id, data: 'hosted-session-key' } });
        const app = createApp(async () => host.id);
        try {
            const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
            const verifyAs = async (actionId: string, input: unknown, method: string, path: string, body?: unknown,
                credential = token, bound: Readonly<{ machineId: string; installationId: string; privateKey: Uint8Array }> = {
                    machineId: fixture.machine.id, installationId: fixture.machine.installationId!, privateKey: fixture.keyPair.secretKey }) => {
                const response = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                    headers: { authorization: `Bearer ${credential}` }, payload: { v: 1, machineId: bound.machineId,
                        envelope: { ...fixture.envelope, requestId: crypto.randomUUID(),
                        target: { kind: 'machine', machineId: bound.machineId }, input } } });
                expect(response.statusCode, response.body).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
                const target = authorization.binding.target;
                return await verifyExternalActionDomainExecutionRequest({
                    authorizationToken: authorization.token, effectActionId: actionId,
                    encodedTarget: encodeExternalActionResolvedTargetV1(target), method, path, body,
                    machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: actionId, target, installationId: bound.installationId,
                        requestId: authorization.binding.requestId, method, path, body, privateKey: bound.privateKey }),
                });
            };
            const read = { machineId: fixture.machine.id };
            expect(await verifyAs('machines.roles.get', read, 'GET', `/v1/machines/${fixture.machine.id}`)).not.toBeNull();
            // A read root cannot mutate, and a mutating root gains no general read purpose.
            expect(await verifyAs('machines.roles.get', read, 'POST', `/v1/machines/${fixture.machine.id}/roles`, {})).toBeNull();
            expect(await verifyAs('notifications.notify_me', { message: 'done' },
                'GET', `/v1/machines/${fixture.machine.id}`)).toBeNull();
            await db.accountApiToken.update({ where: { id: fixture.pat.tokenId }, data: { accessGrant: {
                ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['machines.roles.get'] } } } });
            // Guard: a root bound to another person's Machine is that custodian's root, not the requester's read.
            expect(await verifyAs('machines.roles.get', read, 'GET', `/v1/machines/${fixture.machine.id}`, undefined, token,
                { machineId: host.id, installationId: host.installationId!, privateKey: hostKeys.secretKey })).toBeNull();
            // One foreign-custodian rule: a Team member's Machine reads a requester resource only when the
            // custodian itself holds access to it. The requester's Machine list is not; Machine admission
            // already refuses the plugin-materializations root there.
            const hostBound = { machineId: host.id, installationId: host.installationId!, privateKey: hostKeys.secretKey };
            expect(await verifyAs('machines.list', {}, 'GET', '/v1/machines')).not.toBeNull();
            expect(await verifyAs('machines.list', {}, 'GET', '/v1/machines', undefined, token, hostBound)).toBeNull();
            const widgets = { surface: { serverId: await getOrCreateServerIdentityId(), accountId: fixture.account.id,
                owner: { kind: 'sessionBoard', sessionId: session.id } } };
            const materializations = '/v1/plugins/availability/materializations/read';
            expect(await verifyAs('widgets.catalog.list', widgets, 'POST', materializations, {})).not.toBeNull();
            const foreignWidgets = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('widgets.catalog.list'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: host.id, envelope: { ...fixture.envelope,
                    requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: host.id }, input: widgets } } });
            expect(foreignWidgets.statusCode, foreignWidgets.body).toBe(409);
            // Guard: an API-token root keeps its grant-scoped purposes; it is not the requester's bearer.
            expect(await verifyAs('machines.roles.get', read, 'GET', `/v1/machines/${fixture.machine.id}`, undefined, fixture.pat.token)).toBeNull();
            // Guard: the requester's own Machine must sign. A Session-origin root bound to it but signed by the
            // foreign host of the caller Session (captured source key) gains no general requester read.
            const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
                caller: { kind: 'session', sessionId: session.id, starterDepth: 1, turnDepth: 1 }, sourceTurnId: 'read-turn',
                callerPermissionMode: 'default', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
                requestId: crypto.randomUUID() });
            const envelope = { v: 1, requestId: origin.requestId, target: fixture.envelope.target, input: read } satisfies ExternalActionRequestEnvelopeV1;
            const source = { machineId: host.id, installationId: host.installationId! };
            const installationProof = signMachineInstallationProof({ privateKey: hostKeys.secretKey, payload: { version: 1,
                accountId: fixture.account.id, ...source, externalActionOrigin: { homeId: await getOrCreateServerIdentityId(),
                    actionId: 'machines.roles.get', requestId: origin.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.roles.get'),
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id, envelope,
                    sessionActionOrigin: origin, sessionActionSource: source, installationProof } });
            expect(minted.statusCode, minted.body).toBe(200);
            const hosted = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            expect(hosted.binding).toMatchObject({ custodianAccountId: fixture.account.id, sessionActionSource: source });
            const path = `/v1/machines/${fixture.machine.id}`;
            const signedBy = (privateKey: Uint8Array, installationId: string) => verifyExternalActionDomainExecutionRequest({
                authorizationToken: hosted.token, effectActionId: 'machines.roles.get',
                encodedTarget: encodeExternalActionResolvedTargetV1(hosted.binding.target), method: 'GET', path,
                resolveCurrentSessionMachine: async () => host.id,
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: hosted.token,
                    effectActionId: 'machines.roles.get', target: hosted.binding.target, installationId,
                    requestId: hosted.binding.requestId, method: 'GET', path, privateKey }) });
            expect(await signedBy(hostKeys.secretKey, fixture.machine.installationId!)).toBeNull();
        } finally { await app.close(); }
    });

    it('refuses generic GET bypasses on Session-origin and terminal read-only Account roots while preserving declared purposes', async () => {
        const fixture = await createFixture();
        const homeId = await getOrCreateServerIdentityId();
        const session = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: session.id, data: 'own-session-key' } });
        const app = createApp(async () => fixture.machine.id);
        const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        const accountToken = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const terminalToken = await auth.createToken(fixture.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        try {
            const mintAndVerify = async (
                opts: Readonly<{ actionId: string; input: ExternalActionRequestEnvelopeV1['input']; credential: string; withSessionOrigin: boolean }>,
                method: string,
                path: string,
                body?: unknown,
                routeInput?: unknown,
            ) => {
                const requestId = crypto.randomUUID();
                const envelope = { v: 1, requestId, target: fixture.envelope.target, input: opts.input } satisfies ExternalActionRequestEnvelopeV1;
                const origin = opts.withSessionOrigin ? SessionActionRpcOriginV1Schema.parse({ v: 1,
                    caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
                    sourceTurnId: 'automation-read-turn', callerPermissionMode: null, requestId }) : undefined;
                const installationProof = origin ? signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
                    payload: { version: 1, accountId: fixture.account.id, ...source, externalActionOrigin: {
                        homeId, actionId: opts.actionId, requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } }) : undefined;
                const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(opts.actionId),
                    headers: { authorization: `Bearer ${opts.credential}` }, payload: { v: 1, machineId: fixture.machine.id, envelope,
                        ...(origin ? { sessionActionOrigin: origin, sessionActionSource: source, installationProof } : {}) } });
                expect(minted.statusCode, `${opts.actionId}: ${minted.body}`).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
                return verifyExternalActionDomainExecutionRequest({
                    authorizationToken: authorization.token, effectActionId: opts.actionId,
                    encodedTarget: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                    method, path, body,
                    ...(routeInput === undefined ? {} : { routeInput }),
                    resolveCurrentSessionMachine: async () => fixture.machine.id,
                    machineSignature: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId: opts.actionId,
                        target: authorization.binding.target, installationId: fixture.machine.installationId!,
                        requestId: authorization.binding.requestId, method, path,
                        ...(body === undefined ? {} : { body }), privateKey: fixture.keyPair.secretKey }),
                });
            };

            const artifactId = 'env-artifact-1';
            const headerRead = { artifactIds: [artifactId], projection: 'headers' };
            for (const mode of [
                { label: 'account+sessionActionOrigin', credential: accountToken, withSessionOrigin: true },
                { label: 'terminal+sessionActionOrigin', credential: terminalToken, withSessionOrigin: true },
                { label: 'standalone terminal', credential: terminalToken, withSessionOrigin: false },
            ] as const) {
                const envListInput = { serverId: homeId };
                const envListSpec = getActionSpec('deployments.environments.list');
                const envListRequest = bindHomeDomainHttpRequestV1({
                    transport: envListSpec.serverTransport!, inputSchema: envListSpec.inputSchema, input: envListInput,
                });
                const envList = { actionId: 'deployments.environments.list', input: envListInput, ...mode };
                expect(await mintAndVerify(envList, 'POST', '/v1/artifacts/read', headerRead),
                    `${mode.label}: header-only projection stays admitted`).not.toBeNull();
                expect(await mintAndVerify(envList, envListRequest.method, envListRequest.path, undefined, envListInput),
                    `${mode.label}: declared serverTransport stays admitted`).not.toBeNull();
                expect(await mintAndVerify(envList, 'GET', `/v1/artifacts/${artifactId}`),
                    `${mode.label}: full Artifact GET must be refused`).toBeNull();
                expect(await mintAndVerify(envList, 'GET', '/v1/account/profile'),
                    `${mode.label}: unrelated Account GET must be refused`).toBeNull();
            }

            // Sibling read-only Account roots under automation authority cannot borrow generic GETs.
            const usageQuery = { actionId: 'usage.query', input: { queries: [{ period: { startMs: 100, endMs: 200 } }] },
                credential: accountToken, withSessionOrigin: true };
            expect(await mintAndVerify(usageQuery, 'POST', '/v1/artifacts/read', headerRead),
                'usage.query header-only projection stays admitted').not.toBeNull();
            expect(await mintAndVerify(usageQuery, 'GET', `/v1/artifacts/${artifactId}`),
                'usage.query full Artifact GET must be refused').toBeNull();
            expect(await mintAndVerify(usageQuery, 'GET', '/v1/elsewhere'),
                'usage.query unrelated GET must be refused').toBeNull();

            const recapCompose = { actionId: 'usage.recap.compose', input: { source: { kind: 'public_profile' } },
                credential: accountToken, withSessionOrigin: true };
            expect(await mintAndVerify(recapCompose, 'GET', '/v1/account/public-profile/view'),
                'usage.recap.compose safe-view GET stays admitted').not.toBeNull();
            expect(await mintAndVerify(recapCompose, 'GET', `/v1/artifacts/${artifactId}`),
                'usage.recap.compose Artifact GET must be refused').toBeNull();
            expect(await mintAndVerify(recapCompose, 'GET', '/v1/account/public-profile'),
                'usage.recap.compose owner profile GET must be refused').toBeNull();

            const directoryInput = { v: 1, teamId: 'team-1', limit: 25 };
            const directorySources = { actionId: 'teams.directory.sources.list', input: directoryInput,
                credential: terminalToken, withSessionOrigin: true };
            expect(await mintAndVerify(directorySources, 'GET', '/v1/teams/team-1/directory-sources?limit=25', undefined, directoryInput),
                'teams.directory.sources.list declared GET stays admitted').not.toBeNull();
            expect(await mintAndVerify(directorySources, 'GET', '/v1/teams/team-1/directory-sources?limit=25&view=census', undefined, directoryInput),
                'teams.directory.sources.list extra query shape must be refused').toBeNull();
            expect(await mintAndVerify(directorySources, 'GET', `/v1/artifacts/${artifactId}`),
                'teams.directory.sources.list Artifact GET must be refused').toBeNull();

            // Standalone terminal bindings (account_automation) do not inherit the present-user GET shortcut (RT3).
            const rolesGet = { actionId: 'machines.roles.get', input: { machineId: fixture.machine.id },
                credential: terminalToken, withSessionOrigin: false };
            expect(await mintAndVerify(rolesGet, 'GET', `/v1/machines/${fixture.machine.id}`),
                'standalone terminal machines.roles.get off-transport Machine GET must be refused').toBeNull();
            expect(await mintAndVerify(rolesGet, 'GET', `/v1/artifacts/${artifactId}`),
                'standalone terminal machines.roles.get Artifact GET must be refused').toBeNull();
            expect(await mintAndVerify(rolesGet, 'GET', '/v1/account/profile'),
                'standalone terminal machines.roles.get unrelated GET must be refused').toBeNull();

            const widgetsCatalog = {
                actionId: 'widgets.catalog.list',
                input: { surface: { serverId: homeId, accountId: fixture.account.id, owner: { kind: 'sessionBoard', sessionId: session.id } } },
                credential: terminalToken, withSessionOrigin: false,
            };
            expect(await mintAndVerify(widgetsCatalog, 'POST', '/v1/plugins/availability/materializations/read', {}),
                'standalone terminal widgets.catalog.list declared materializations POST stays admitted').not.toBeNull();
            expect(await mintAndVerify(widgetsCatalog, 'GET', '/v1/machines'),
                'standalone terminal widgets.catalog.list off-transport Machine list GET must be refused').toBeNull();

            const workflowValidate = {
                actionId: 'workflow.validate',
                input: { definition: { version: 1, defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } }, blocks: ['Review this'] } },
                credential: terminalToken, withSessionOrigin: false,
            };
            expect(await mintAndVerify(workflowValidate, 'GET', '/v1/machines'),
                'standalone terminal workflow.validate off-transport Machine list GET must be refused').toBeNull();

            // Guard: present-user session.targets.resolve still cannot borrow the read-root GET shortcut for Session messages (RT5).
            const targetsResolve = {
                actionId: 'session.targets.resolve',
                input: { target: { selector: 'workers' }, actionId: 'session.message.send' },
                credential: accountToken, withSessionOrigin: false,
            };
            expect(await mintAndVerify(targetsResolve, 'GET', `/v2/sessions/${session.id}/messages`),
                'present-user session.targets.resolve non-preparation messages GET must be refused').toBeNull();
        } finally { await app.close(); }
    });

    it('refuses Session-route transcript GETs on automation and foreign-custodian read roots via real HTTP routing while preserving present-user and own-session reads (RT5/RT6)', async () => {
        const fixture = await createFixture();
        const homeId = await getOrCreateServerIdentityId();
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const hostKeys = tweetnacl.sign.keyPair();
        const host = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(hostKeys.publicKey) } });
        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: host.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const callerSession = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const otherSession = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: callerSession.id, data: 'caller-session-key' } });
        await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
            sessionId: otherSession.id, data: 'other-session-key' } });
        const app = createApp(async () => fixture.machine.id);
        registerSessionListingRoutes(app);
        registerSessionMessageRoutes(app);
        registerSessionTurnMutationRoute(app);
        sessionPendingRoutes(app);
        changesRoutes(app);
        registerSessionSystemRecordRoutes(app);
        featuresRoutes(app);
        const ownBound = { machineId: fixture.machine.id, installationId: fixture.machine.installationId!, privateKey: fixture.keyPair.secretKey };
        const foreignBound = { machineId: host.id, installationId: host.installationId!, privateKey: hostKeys.secretKey };
        const accountToken = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const terminalToken = await auth.createToken(fixture.account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        try {
            const mintAndGetHttp = async (
                opts: Readonly<{
                    actionId: string;
                    input: ExternalActionRequestEnvelopeV1['input'];
                    credential: string;
                    withSessionOrigin: boolean;
                    bound?: Readonly<{ machineId: string; installationId: string; privateKey: Uint8Array }>;
                }>,
                path: string,
            ) => {
                const bound = opts.bound ?? ownBound;
                const requestId = crypto.randomUUID();
                const envelope = { v: 1, requestId, target: { kind: 'machine', machineId: bound.machineId }, input: opts.input } satisfies ExternalActionRequestEnvelopeV1;
                const source = { machineId: bound.machineId, installationId: bound.installationId };
                const origin = opts.withSessionOrigin ? SessionActionRpcOriginV1Schema.parse({ v: 1,
                    caller: { kind: 'session', sessionId: callerSession.id, starterDepth: 0, turnDepth: 0 },
                    sourceTurnId: 'session-route-probe-turn', callerPermissionMode: null, requestId }) : undefined;
                const installationProof = origin ? signMachineInstallationProof({ privateKey: bound.privateKey,
                    payload: { version: 1, accountId: fixture.account.id, ...source, externalActionOrigin: {
                        homeId, actionId: opts.actionId, requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } }) : undefined;
                const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(opts.actionId),
                    headers: { authorization: `Bearer ${opts.credential}` }, payload: { v: 1, machineId: bound.machineId, envelope,
                        ...(origin ? { sessionActionOrigin: origin, sessionActionSource: source, installationProof } : {}) } });
                expect(minted.statusCode, `${opts.actionId}: ${minted.body}`).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
                const machineSignature = signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId: opts.actionId,
                    target: authorization.binding.target, installationId: bound.installationId,
                    requestId: authorization.binding.requestId, method: 'GET', path, privateKey: bound.privateKey });
                return app.inject({
                    method: 'GET',
                    url: path,
                    headers: {
                        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                        [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: machineSignature,
                        [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: opts.actionId,
                        [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                    },
                });
            };
            const expectHttpAdmitted = (response: Awaited<ReturnType<typeof mintAndGetHttp>>, label: string) => {
                expect(response.statusCode, `${label}: ${response.body}`).toBe(200);
            };
            const expectHttpPurposeRefused = (response: Awaited<ReturnType<typeof mintAndGetHttp>>, label: string) => {
                expect(response.statusCode, `${label}: ${response.body}`).toBe(401);
                expect(response.json(), label).toMatchObject({ error: 'invalid_token', authorizationRefusal: 'verification_purpose' });
            };

            const envListInput = { serverId: homeId };
            // RT6: Session-origin and standalone-terminal read roots cannot GET another requester Session's transcript route.
            for (const mode of [
                { label: 'account+sessionActionOrigin', credential: accountToken, withSessionOrigin: true },
                { label: 'terminal+sessionActionOrigin', credential: terminalToken, withSessionOrigin: true },
                { label: 'standalone terminal', credential: terminalToken, withSessionOrigin: false },
            ] as const) {
                const envList = { actionId: 'deployments.environments.list', input: envListInput, ...mode };
                expectHttpPurposeRefused(await mintAndGetHttp(envList, `/v1/sessions/${otherSession.id}/messages`),
                    `RT6 ${mode.label}: other Session v1 transcript GET must be refused`);
                expectHttpPurposeRefused(await mintAndGetHttp(envList, `/v2/sessions/${otherSession.id}/messages/replies/pending`),
                    `RT6 ${mode.label}: other Session v2 replies pending GET must be refused`);
                expectHttpPurposeRefused(await mintAndGetHttp(envList, `/v2/sessions/${otherSession.id}`),
                    `RT6 ${mode.label}: other Session detail GET must be refused`);
                if (mode.withSessionOrigin) {
                    expectHttpAdmitted(await mintAndGetHttp(envList, `/v2/sessions/${callerSession.id}`),
                        `RT6 ${mode.label}: caller's own Session detail GET stays admitted`);
                }
            }

            // RT6 (foreign custodian): positive control proves the foreign fixture & signature reach admission
            // before asserting requester Session transcript routes are refused.
            const foreignEnvList = { actionId: 'deployments.environments.list', input: envListInput,
                credential: accountToken, withSessionOrigin: false, bound: foreignBound };
            expectHttpAdmitted(await mintAndGetHttp(foreignEnvList, '/v1/features/authenticated'),
                'RT6 foreign custodian positive control: authenticated features discovery stays admitted');
            expectHttpPurposeRefused(await mintAndGetHttp(foreignEnvList, `/v1/sessions/${otherSession.id}/messages`),
                'RT6 foreign custodian present_user read root: other Session transcript GET must be refused');
            expectHttpPurposeRefused(await mintAndGetHttp(foreignEnvList, `/v2/sessions/${otherSession.id}/messages/replies/pending`),
                'RT6 foreign custodian present_user read root: other Session v2 replies pending GET must be refused');
            expectHttpPurposeRefused(await mintAndGetHttp(foreignEnvList, `/v2/sessions/${otherSession.id}/execution-runs/run-1/pending`),
                'RT6 foreign custodian present_user read root: other Session execution-run pending GET must be refused');

            // RT6 (Session-surface read root): widgets.catalog.list under Session-origin keeps exact Session detail
            // and real non-transcript widget metadata routes, but cannot borrow any other Session transcript-class route.
            const widgetsList = {
                actionId: 'widgets.catalog.list',
                input: { surface: { serverId: homeId, accountId: fixture.account.id, owner: { kind: 'sessionBoard', sessionId: callerSession.id } } },
                credential: accountToken, withSessionOrigin: true,
            };
            expectHttpAdmitted(await mintAndGetHttp(widgetsList, `/v2/sessions/${otherSession.id}`),
                'RT6 widgets.catalog.list Session-origin: exact other Session detail GET stays admitted');
            expectHttpAdmitted(await mintAndGetHttp(widgetsList, `/v2/sessions/${otherSession.id}?accessProjectionVersion=1`),
                'RT6 widgets.catalog.list Session-origin: exact other Session detail projection GET stays admitted');
            expectHttpAdmitted(await mintAndGetHttp(widgetsList, `/v2/sessions/${otherSession.id}/system-records`),
                'RT6 widgets.catalog.list Session-origin: non-transcript Session system-records GET stays admitted');
            for (const [label, path] of [
                ['v1 messages', `/v1/sessions/${otherSession.id}/messages`],
                ['v2 replies pending', `/v2/sessions/${otherSession.id}/messages/replies/pending`],
                ['v2 message by localId', `/v2/sessions/${otherSession.id}/messages/by-local-id/msg-1`],
                ['v1 percent-encoded messages', `/v1/sessions/${otherSession.id}/%6Dessages`],
                ['v2 percent-encoded replies pending', `/v2/sessions/${otherSession.id}/%6Dessages/replies/pending`],
                ['v2 percent-encoded message by localId', `/v2/sessions/${otherSession.id}/%6Dessages/by-local-id/msg-1`],
                ['v1 turns', `/v1/sessions/${otherSession.id}/turns`],
                ['v2 pending', `/v2/sessions/${otherSession.id}/pending`],
                ['v2 execution-run pending (N1)', `/v2/sessions/${otherSession.id}/execution-runs/run-1/pending`],
                ['v2 percent-encoded execution-run pending (N1)', `/v2/sessions/${otherSession.id}/execution-runs/run-1/%70ending`],
                ['v2 changes query', `/v2/changes?sessionId=${encodeURIComponent(otherSession.id)}`],
            ] as const) {
                expectHttpPurposeRefused(await mintAndGetHttp(widgetsList, path),
                    `RT6 widgets.catalog.list Session-origin: other Session ${label} GET must be refused`);
            }

            // RT5: session.targets.resolve shield stays intact through real HTTP routing while preparation and present-user reads stay admitted.
            const targetsResolve = {
                actionId: 'session.targets.resolve',
                input: { target: { selector: 'workers' }, actionId: 'session.message.send' },
                credential: accountToken, withSessionOrigin: false,
            };
            expectHttpAdmitted(await mintAndGetHttp(targetsResolve, `/v2/sessions/${otherSession.id}`),
                'RT5 present-user session.targets.resolve selector detail preparation stays admitted');
            expectHttpPurposeRefused(await mintAndGetHttp(targetsResolve, `/v2/sessions/${otherSession.id}/messages/replies/pending`),
                'RT5 present-user session.targets.resolve v2 replies pending GET must be refused');
            expectHttpPurposeRefused(await mintAndGetHttp(targetsResolve, `/v1/sessions/${otherSession.id}/messages`),
                'RT5 present-user session.targets.resolve v1 messages GET must be refused');

            // Present-user own-Machine read root keeps present-user equivalence for requester Session routes (including run pending).
            const presentUserEnvList = { actionId: 'deployments.environments.list', input: envListInput,
                credential: accountToken, withSessionOrigin: false };
            expectHttpAdmitted(await mintAndGetHttp(presentUserEnvList, `/v1/sessions/${otherSession.id}/messages`),
                'RT5 present-user own-Machine read root keeps requester Session v1 messages GET equivalence');
            expectHttpAdmitted(await mintAndGetHttp(presentUserEnvList, `/v2/sessions/${otherSession.id}/messages/replies/pending`),
                'RT5 present-user own-Machine read root keeps requester Session v2 replies pending GET equivalence');
            expectHttpAdmitted(await mintAndGetHttp(presentUserEnvList, `/v2/sessions/${otherSession.id}/execution-runs/run-1/pending`),
                'RT5 present-user own-Machine read root keeps requester Session execution-run pending GET equivalence');
        } finally { await app.close(); }
    });

    it('admits unrestricted PAT read-root POST on own Machine and refuses foreign-custodian Machine (RT7 / F4)', async () => {
        const fixture = await createFixture();
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const hostKeys = tweetnacl.sign.keyPair();
        const host = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: custodian.id,
            metadata: fixture.machine.metadata, dataEncryptionKey: fixture.machine.dataEncryptionKey,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(hostKeys.publicKey) } });
        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: host.id,
            principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' }));
        const app = createApp(async () => fixture.machine.id);
        try {
            const verifyPatPost = async (bound: Readonly<{ machineId: string; installationId: string; privateKey: Uint8Array }>) => {
                const read = { machineId: fixture.machine.id };
                const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('machines.roles.get'),
                    headers: { authorization: `Bearer ${fixture.pat.token}` }, payload: { v: 1, machineId: bound.machineId,
                        envelope: { ...fixture.envelope, requestId: crypto.randomUUID(),
                            target: { kind: 'machine', machineId: bound.machineId }, input: read } } });
                expect(minted.statusCode, minted.body).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
                const path = `/v1/machines/${fixture.machine.id}/roles`;
                return verifyExternalActionDomainExecutionRequest({
                    authorizationToken: authorization.token, effectActionId: 'machines.roles.get',
                    encodedTarget: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                    method: 'POST', path, body: {},
                    machineSignature: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId: 'machines.roles.get',
                        target: authorization.binding.target, installationId: bound.installationId,
                        requestId: authorization.binding.requestId, method: 'POST', path, body: {}, privateKey: bound.privateKey }),
                });
            };

            // F4: unrestricted PAT equivalence requires requester-own Machine; a foreign custodian cannot
            // borrow Account-wide off-transport POST rights on the host daemon.
            const ownResult = await verifyPatPost({
                machineId: fixture.machine.id, installationId: fixture.machine.installationId!, privateKey: fixture.keyPair.secretKey });
            expect(ownResult, 'RT7 unrestricted PAT read root POST on own Machine stays admitted').not.toBeNull();
            const foreignResult = await verifyPatPost({
                machineId: host.id, installationId: host.installationId!, privateKey: hostKeys.secretKey });
            expect(foreignResult, 'RT7 unrestricted PAT read root POST on foreign-custodian Machine must be refused').toBeNull();
        } finally { await app.close(); }
    });
});
