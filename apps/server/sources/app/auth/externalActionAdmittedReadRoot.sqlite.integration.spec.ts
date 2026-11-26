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
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
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
});
