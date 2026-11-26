import { Server } from 'socket.io';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { createExternalActionDaemonDispatchResponseV1, prepareExternalActionResponseEnvelopeV1, bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionHttpErrorSchema, ExternalActionResponseEnvelopeV1Schema, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, type ExternalActionDaemonDispatchRequest } from '@happier-dev/protocol/actions';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contributionIdentity';
import { DaemonPluginStructuredMessageActionExecuteRequestSchema } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { callSocketRpc } from '@happier-dev/sync-client';
import { withUserScopedRpcSocket } from '../../../../../../cli/src/session/transport/rpc/withUserScopedRpcSocket';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { buildRpcMethodRoom } from '@/app/api/socket/rpc/rpcMethodRoom';
import { createMachinePresenceDeadlineOwner, stopLocalMachinePresenceTimeout } from '@/app/presence/timeout';
import { startTeamCredentialActionSocketPresence } from '@/testkit/teamCredentialActionSocketPresence.testkit';
import type { Fastify as AppFastify } from '@/app/api/types';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';

let harness: LightSqliteHarness;
const homeId = 'srv_machineUnavailableHome';
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'machine-unavailable-', initAuth: true,
        env: { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true', HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS: '2000' } });
}, 120_000);
afterAll(async () => { if (harness) await harness.close(); });

async function withActionRelayFixture(
    options: Parameters<typeof createActionRelayFixture>[0],
    run: (fixture: Awaited<ReturnType<typeof createActionRelayFixture>>) => Promise<void>,
) {
    const fixture = await createActionRelayFixture(options);
    try { await run(fixture); }
    finally { await fixture.close(); }
}

async function createActionRelayFixture(options: Readonly<{
    active?: boolean; withoutInstallation?: boolean; power?: 'stopped' | 'suspended';
}>) {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const installationId = crypto.randomUUID();
    const keys = tweetnacl.sign.keyPair();
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id,
        metadata: encodePlainMachineStoredContent({ host: 'fixture', platform: 'linux' }),
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        installationId: options.withoutInstallation ? null : installationId, installationPublicKey: keys.publicKey,
        active: options.active ?? false,
        operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
    if (options.power) await db.managedMachine.create({ data: {
        homeId, custodianAccountId: account.id, enrolledMachineId: machine.id,
        admittedActionRequestId: crypto.randomUUID(), admittedInput: {}, launch: {}, retention: { kind: 'until-delete' },
        observation: { observedAt: 1, availability: 'present', power: options.power }, wakeOnAcceptedMessage: false,
    } });
    const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
    const app: AppFastify = createAuthenticatedTestApp({ authentication: 'real' });
    const sockets = startTeamCredentialActionSocketPresence(app);
    registerExternalActionRoutes(app);
    const io = app.machineDaemonPresence;
    if (!(io instanceof Server)) throw new Error('Expected Home socket discovery');
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const method = `${machine.id}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`;
    const methodRoom = buildRpcMethodRoom({ userId: account.id, method });
    const delivered: string[] = [];
    const connectMachineSocket = () => sockets.connect({ baseUrl, token, accountId: account.id,
        machineId: machine.id, installationId, keys });
    return {
        account, machine, app, token, io, baseUrl, methodRoom, delivered, connectMachineSocket,
        async connectDaemon() {
            const daemon = await connectMachineSocket();
            daemon.on(SOCKET_RPC_EVENTS.REQUEST, ({ params }: { params: ExternalActionDaemonDispatchRequest },
                ack: (response: unknown) => void) => {
                const { envelope, actionId } = params;
                delivered.push(envelope.requestId!);
                ack(createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({
                    v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result: { accepted: true } },
                })));
            });
            daemon.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
            await vi.waitFor(() => expect(io.sockets.adapter.rooms.get(methodRoom)?.has(daemon.id!)).toBe(true));
            return daemon;
        },
        readActive: async () => (await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).active,
        async close() {
            await sockets.close();
            await stopLocalMachinePresenceTimeout();
            await app.close();
        },
    };
}

const offline = { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' };
const missingInstallation = { reason: 'machine_installation_missing', requiredFact: 'machine_installation', remedy: 'register_machine' };

it.each<{
    entry: string;
    diagnostic: typeof offline;
    active?: boolean;
    withoutInstallation?: boolean;
    mint?: boolean;
    power?: 'stopped' | 'suspended';
    inventoryActionId?: 'agents.models.list' | 'agents.config_options.list';
}>([
    { entry: 'retained offline', diagnostic: offline },
    ...(['stopped', 'suspended'] as const).map(power => ({
        entry: `managed observation ${power}`, power, diagnostic: { ...offline, reason: `machine_${power}` },
    })),
    { entry: 'stale online without a route', active: true, diagnostic: offline },
    { entry: 'retained without installation', withoutInstallation: true, diagnostic: missingInstallation },
    { entry: 'authorization mint without installation', mint: true, withoutInstallation: true, diagnostic: missingInstallation },
    ...(['agents.models.list', 'agents.config_options.list'] as const).map(inventoryActionId => ({
        entry: `authorization mint for offline ${inventoryActionId}`, inventoryActionId, diagnostic: offline, mint: true,
    })),
])('returns a typed refusal for an unavailable Machine ($entry)', async test => {
    await withActionRelayFixture(test, async ({ app, token, machine, delivered }) => {
        const { inventoryActionId } = test;
        const actionId = inventoryActionId ?? 'machines.services.list';
        const envelope = { v: 1, target: { kind: 'machine', machineId: machine.id },
            input: { machineId: machine.id, ...(inventoryActionId ? { agentId: 'muse' } : { serverId: homeId }) } };
        const response = await app.inject({ method: 'POST',
            url: test.mint ? bindExternalActionExecutionAuthorizationHttpPathV1(actionId) : `/v1/actions/${actionId}`,
            headers: { authorization: `Bearer ${token}` },
            payload: test.mint ? { v: 1, machineId: machine.id, envelope } : envelope });
        expect(response.statusCode, response.body).toBe(test.mint ? 409 : 200);
        if (test.mint) {
            expect(ExternalActionHttpErrorSchema.parse(response.json()))
                .toMatchObject({ code: 'target_unavailable', diagnostic: test.diagnostic });
        } else {
            expect(ExternalActionResponseEnvelopeV1Schema.parse(response.json()).execution)
                .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: test.diagnostic });
        }
        expect(delivered).toEqual([]);
    });
});

it.each((['action.operations.list', 'action.operations.get', 'action.operations.cancel'] as const)
    .flatMap(actionId => [true, false].map(active => ({ actionId, active }))))(
    'delivers retained $actionId through the exact connected installation with persisted active=$active', async ({ actionId, active }) => {
        await withActionRelayFixture({}, async ({ app, token, machine, connectDaemon, delivered, readActive }) => {
            await connectDaemon();
            if (!active) await db.machine.update({ where: { id: machine.id }, data: { active } });
            expect(await readActive()).toBe(active);
            const requestId = crypto.randomUUID();
            const response = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, requestId, target: { kind: 'machine', machineId: machine.id },
                    input: { serverId: homeId, machineId: machine.id,
                        ...(actionId === 'action.operations.list' ? {} : { operationId: crypto.randomUUID() }) } } });
            expect(response.statusCode, response.body).toBe(200);
            expect(ExternalActionResponseEnvelopeV1Schema.parse(response.json()).execution, response.body)
                .toMatchObject({ ok: true, result: { accepted: true } });
            expect(delivered).toEqual([requestId]);
        });
    },
);

it('admits a fresh exact detail retry through Machine RPC after a ping timeout', async () => {
    await withActionRelayFixture({}, async ({ account, machine, token, io, baseUrl, readActive, connectMachineSocket }) => {
        // Bound the real Engine.IO heartbeat for this fixture's connections.
        io.engine.opts.pingInterval = 1_000;
        io.engine.opts.pingTimeout = 1_000;
        const rpcMethod = RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE;
        const method = `${machine.id}:${rpcMethod}`;
        const room = buildRpcMethodRoom({ userId: account.id, method });
        const action = buildQualifiedPluginContributionKey({ pluginId: 'happier.scm.forge.github', localId: 'triage/get-github-entry-native' });
        const detail = { number: 140, title: 'Fixture pull request' };
        const handled: string[] = [];
        const connect = async () => {
            const daemon = await connectMachineSocket();
            daemon.on(SOCKET_RPC_EVENTS.REQUEST, ({ params }: { params: unknown }, ack: (result: unknown) => void) => {
                const input = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(params);
                handled.push(input.requestId!);
                ack({ ok: true, result: detail });
            });
            daemon.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
            await vi.waitFor(() => expect(io.sockets.adapter.rooms.get(room)?.has(daemon.id!)).toBe(true));
            return daemon;
        };
        const read = (requestId: string) => withUserScopedRpcSocket({ token, serverUrl: baseUrl, connectTimeoutMs: 5_000 },
            async (socket, ready) => {
                await ready();
                return callSocketRpc({ socket, target: { kind: 'machine', id: machine.id }, method: rpcMethod,
                    requestId, content: { mode: 'plain' },
                    params: DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
                        machineId: machine.id, requestId, qualifiedActionId: action, executionSurface: 'ui',
                        expectedContributorOccurrenceId: 'github-occurrence',
                        invocation: { kind: 'clientPluginAction', clientActionBinding: {
                            pluginId: 'happier.scm.forge.github', contributionLocalId: 'triage/get-github-entry',
                            occurrenceId: 'github-occurrence',
                        } },
                        input: { localRef: { kindId: 'pull-request', entryId: '140' } },
                    }) });
            });
        const first = await connect();
        const controlId = crypto.randomUUID();
        expect(await read(controlId)).toEqual({ ok: true, result: detail });
        let disconnectReason: string | undefined;
        io.sockets.sockets.get(first.id!)!.once('disconnect', reason => { disconnectReason = reason; });
        // Stop answering pings at the transport boundary and let Home expire the socket.
        const transport = first.io.engine.transport;
        const send = transport.send.bind(transport);
        vi.spyOn(transport, 'send').mockImplementation(packets => send(packets.filter(packet => packet.type !== 'pong')));
        await vi.waitFor(() => expect(disconnectReason).toBe('ping timeout'), { timeout: 5_000 });
        await vi.waitFor(async () => expect(await readActive()).toBe(false));
        expect(io.sockets.adapter.rooms.has(room)).toBe(false);

        const unavailableId = crypto.randomUUID();
        await expect(read(unavailableId)).rejects.toMatchObject({ rpcErrorCode: 'target_unavailable' });
        expect(handled).toEqual([controlId]);

        await connect();
        // The replacement can serve requests even if its stored heartbeat observation has expired.
        const lastActiveAt = new Date(0);
        await db.machine.update({ where: { id: machine.id }, data: { lastActiveAt } });
        const deadlines = createMachinePresenceDeadlineOwner();
        try {
            deadlines.schedule({ machineId: machine.id, accountId: account.id, lastActiveAt });
            await vi.waitFor(async () => expect(await readActive()).toBe(false));
            const retryId = crypto.randomUUID();
            expect(await read(retryId)).toEqual({ ok: true, result: detail });
            expect(handled).toEqual([controlId, retryId]);
        } finally { await deadlines.stop(); }
    });
});

it.each(['connected after persisted presence expired', 'reconnecting after disconnect'] as const)(
    'delivers a new Action once to a Machine %s', async (scenario) => {
        await withActionRelayFixture({}, async ({ app, token, account, machine, io, methodRoom, connectDaemon, readActive, delivered }) => {
            const invoke = (requestId: string) => app.inject({ method: 'POST', url: '/v1/actions/machines.services.list',
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, requestId, target: { kind: 'machine', machineId: machine.id },
                    input: { machineId: machine.id, serverId: homeId } } });
            const expectDelivered = (response: Awaited<ReturnType<typeof invoke>>) => {
                expect(response.statusCode, response.body).toBe(200);
                expect(ExternalActionResponseEnvelopeV1Schema.parse(response.json()).execution, response.body)
                    .toMatchObject({ ok: true, result: { accepted: true } });
            };
            const first = await connectDaemon();
            const controlId = crypto.randomUUID();
            expect(await readActive()).toBe(true);
            expectDelivered(await invoke(controlId));
            expect(delivered).toEqual([controlId]);

            const requestId = crypto.randomUUID();
            if (scenario === 'connected after persisted presence expired') {
                // Move the stored observation past its deadline while the real registration stays live.
                const lastActiveAt = new Date(0);
                await db.machine.update({ where: { id: machine.id }, data: { lastActiveAt } });
                const deadlines = createMachinePresenceDeadlineOwner();
                try {
                    deadlines.schedule({ machineId: machine.id, accountId: account.id, lastActiveAt });
                    await vi.waitFor(async () => expect(await readActive()).toBe(false));
                    expect(first.connected).toBe(true);
                    expectDelivered(await invoke(requestId));
                } finally { await deadlines.stop(); }
            } else {
                first.disconnect();
                await vi.waitFor(async () => expect(await readActive()).toBe(false));
                expect(io.sockets.adapter.rooms.has(methodRoom)).toBe(false);
                const fetchSockets = io.sockets.adapter.fetchSockets.bind(io.sockets.adapter);
                let discoveryStarted!: () => void;
                const discovery = new Promise<void>(resolve => { discoveryStarted = resolve; });
                const witness = vi.spyOn(io.sockets.adapter, 'fetchSockets').mockImplementation(options => {
                    const result = fetchSockets(options);
                    if (options.rooms.has(methodRoom)) discoveryStarted();
                    return result;
                });
                try {
                    const pending = invoke(requestId);
                    // Reattach after the empty-room census. Early refusal settles before discovery.
                    await Promise.race([discovery, pending]);
                    await connectDaemon();
                    expectDelivered(await pending);
                } finally { witness.mockRestore(); }
            }
            expect(delivered).toEqual([controlId, requestId]);
        });
    },
);
