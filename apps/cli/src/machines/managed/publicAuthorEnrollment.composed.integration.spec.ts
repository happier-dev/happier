import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createDeploymentSocketHome } from '../../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { db } from '../../../../server/sources/storage/db';
import { auth } from '../../../../server/sources/app/auth/auth';
import { inTx } from '../../../../server/sources/storage/inTx';
import { setEligibleMachineAccessGrantInTx } from '../../../../server/sources/testkit/machineAccessGrant.testkit';
import { createSignedAccountContentBinding } from '../../../../server/sources/testkit/accountEncryption';
import { commitMachineRecipientKeyEnvelopesInTx, readMachineRecipientCensusInTx } from '../../../../server/sources/app/machines/machineAccess';
import nacl from 'tweetnacl';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { reloadConfiguration } from '@/configuration';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import * as installationStore from '@/daemon/identity/store';
import { createS0DeploymentDaemonIngress, installationBoundary, readS0Installation, readS0ControllerCredentials } from '@/deployments/deploymentDaemonIngress.testkit';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import { decodeStoredCredentials, encodeStoredCredentials } from '@/persistence';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { registerMachineWorkSummaryRpcHandlers } from '@/api/machine/rpcHandlers.machineWorkSummary';
import { createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { registerMachineTerminalRpcHandlers } from '@/api/machine/rpcHandlers.terminal';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { TerminalStreamReadResponseSchema, decodeTerminalStreamBytesFrame, computeContentPublicKeyFingerprint,
    sealEncryptedDataKeyEnvelopeV1, encodeBase64, type ActionId, type JsonValue } from '@happier-dev/protocol';
import { acquireEnrollmentJourneyGuest } from './enrollmentJourney.testkit';

vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, lstat: vi.fn(actual.lstat), realpath: vi.fn(actual.realpath) };
});
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: vi.fn(actual.spawn) };
});

it.skipIf(process.platform !== 'linux')('public-only author enrolls its retained resource through signed Home admission and the receiving host', async () => {
    const directory = await createTempDir('public-author-enrollment-');
    onTestFinished(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); reloadConfiguration(); await removeTempDir(directory); });
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
    reloadConfiguration();
    const home = await createDeploymentSocketHome({ encryptionMode: 'e2ee',
        dbProvider: process.env.HAPPIER_DB_PROVIDER === 'postgres' ? 'postgres' : 'sqlite',
        prepareMachineContent: (key, metadata) => createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: key,
            encryptionVariant: 'dataKey' }).encodeStored(metadata) });
    onTestFinished(() => home.close());
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockImplementation(
        () => installationBoundary.getStore() ?? readS0Installation(home));
    let controller: Awaited<ReturnType<typeof createS0DeploymentDaemonIngress>> | undefined;
    let received = false;
    let terminals: ReturnType<typeof registerMachineTerminalRpcHandlers> | undefined;
    let nativeAcquisitions = 0;
    const guest = await acquireEnrollmentJourneyGuest(home, {
        confirmWholeOperation: true,
        acquireInput: { enrollmentIdentity: { kind: 'existingUser', role: 'personal' }, selection: {
            kind: 'one-off', homeId: home.serverId, controller: { machineId: home.machineId, installationId: home.installationId },
            launch: { provider: { pluginId: 'examples.machine-provisioner', localId: 'guest' }, schemaVersion: 1,
                name: 'Public author guest', choices: { name: 'local' } }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } },
        native: { publicAuthor: true, execute: async (role, _body, _context, next) => {
            if (role === 'acquire') {
                const rows = await db.managedMachine.findMany({ where: { controllerMachineId: home.machineId } });
                expect(rows).toHaveLength(1);
                expect(rows[0]).toMatchObject({ allocation: 'may-exist', resource: null, enrolledMachineId: null });
                nativeAcquisitions++;
            }
            await next();
        } },
        startController: async managedMachineAction => {
            controller = await createS0DeploymentDaemonIngress({ home, managedMachineAction });
            return controller;
        },
        startGuest: async (guest, nativeBoundary) => {
            const workspace = join(directory, 'workspace');
            await mkdir(workspace);
            const receiver = await createS0DeploymentDaemonIngress({ home: guest, nativeBoundary,
                // The installed terminal ingress enforces requester custody (or
                // refuses before effects); Home requires its advertised support.
                operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } },
                configureRpc(rpc) {
                    const methods: string[] = [];
                    terminals = registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler(method, handler) {
                        methods.push(method); rpc.registerHandler(method, handler);
                    } }, deps: { serverId: home.serverId, resolveHostHomeServerIdentityId: async () => home.serverId,
                        env: { ...process.env, HAPPIER_DAEMON_TERMINAL_ENABLED: '1', HAPPIER_DAEMON_TERMINAL_SHELL: '/bin/sh' },
                        workingDirectory: workspace } });
                    onTestFinished(() => terminals!.dispose());
                    const activity = createManagedActivityInventory({ producers: [terminals.getSessionManager().getLiveWorkProducer()] });
                    onTestFinished(() => activity.dispose());
                    const access = createAccountServerActionDeps({ token: home.token, serverId: home.serverId, serverHttpBaseUrl: home.baseUrl });
                    registerMachineWorkSummaryRpcHandlers({ rpcHandlerManager: rpc,
                        target: { serverId: home.serverId, machineId: guest.machineId, installationId: guest.installationId },
                        custodianAccountId: home.accountId, activity,
                        readAccess: signal => access.machineAccessAction!({ actionId: 'machines.access.grants.list',
                            input: { serverId: home.serverId, machineId: guest.machineId },
                            context: { surface: 'cli', serverId: home.serverId }, signal }) });
                    return [...methods, RPC_METHODS.MACHINES_WORK_SUMMARY_GET];
                } });
            onTestFinished(() => receiver.close());
            received = true;
        },
    });
    expect(received).toBe(true);
    expect(await db.session.count()).toBe(0);
    expect(nativeAcquisitions).toBe(1);
    const rows = await db.managedMachine.findMany({ where: { controllerMachineId: home.machineId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ allocation: 'bound', enrolledMachineId: guest.machineId,
        resource: { contributionRef: { pluginId: 'examples.machine-provisioner', localId: 'guest' }, value: { name: 'local' } } });
    expect(guest.machineId).not.toBe(home.machineId);
    const operations = controller!.actionOperations.store.list({ accountId: home.accountId, machineId: home.machineId }).items;
    expect(operations.filter(operation => operation.actionId === 'machines.managed.acquire')).toMatchObject([{ state: 'succeeded' }]);
    const credentials = readS0ControllerCredentials(home);
    const target = { kind: 'machine' as const, machineId: guest.machineId };
    const confirmDisclosure: NonNullable<Parameters<typeof dispatchOriginalAccountAction>[0]['onRequesterSessionCredentialDisclosure']> = async disclosure => {
        expect(disclosure.custodian?.accountId).toBe(home.accountId);
        return true;
    };
    const executeAs = (actorCredentials: typeof credentials, accountId: string, consentToDisclosure = false) => (actionId: ActionId, input: JsonValue) => {
        const requestId = randomUUID();
        return dispatchOriginalAccountAction({ actionId, input, requestId, target, credentials: actorCredentials,
            serverHttpBaseUrl: home.baseUrl, serverIdentityId: home.serverId,
            ...(consentToDisclosure ? { onRequesterSessionCredentialDisclosure: confirmDisclosure } : {}),
            invocation: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' },
                presentUserConfirmation: { actionId, requestId, accountId, serverId: home.serverId, target,
                    inputDigest: computeActionInputApprovalDigestV1(actionId, input) } } });
    };
    const execute = executeAs(credentials, home.accountId);
    const routing = { serverId: home.serverId, machineId: guest.machineId };
    const open = { ...routing, terminalKey: 'author-shell', cwd: join(directory, 'workspace') };
    await expect(execute('machines.terminal.open', { ...open, runtimeBinding: { accountId: 'foreign', token: 'private-binding' } }))
        .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    await expect(execute('machines.work.summary.get', { ...routing, sessionId: 'foreign-session' }))
        .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(terminals!.getSessionManager().list()).toEqual([]);
    const opened = await execute('machines.terminal.open', open);
    expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true, result: { ok: true, reused: false } });
    if (!opened.ok || !opened.result || typeof opened.result !== 'object' || Array.isArray(opened.result)
        || typeof opened.result.terminalId !== 'string') throw new Error('Missing public terminal');
    let terminalId = opened.result.terminalId;
    expect(terminals!.getSessionManager().list()).toMatchObject([{ terminalId }]);
    expect(terminals!.getSessionManager().list()[0]!.sessionId).toBeUndefined();
    expect(await db.session.count()).toBe(0);
    const summary = await execute('machines.work.summary.get', routing);
    // The canonical summary lists other requesters and omits the custodian's work.
    expect(summary).toMatchObject({ ok: true, result: { kind: 'current', requesters: [] } });
    expect(JSON.stringify(summary)).not.toContain(terminalId);
    expect(JSON.stringify(summary)).not.toContain(directory);
    // A real Manage recipient may inspect the summary, but receives neither shell bytes
    // nor a way to mutate another requester's terminal. Home signs both calls.
    const keys = nacl.box.keyPair();
    const member = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } });
    const token = await auth.createToken(member.id, undefined, { kind: 'account', authority: 'present_user',
        authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }] });
    expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: home.accountId,
        machineId: guest.machineId, principal: { kind: 'account', accountId: member.id }, level: 'admin' }))).toMatchObject({ kind: 'saved' });
    const census = await inTx(tx => readMachineRecipientCensusInTx(tx, { actorAccountId: home.accountId, machineId: guest.machineId }));
    if ('kind' in census || !guest.machineEncryptionKey) throw new Error('Missing guest recipient census');
    expect(await inTx(tx => commitMachineRecipientKeyEnvelopesInTx(tx, {
        actorAccountId: home.accountId, machineId: guest.machineId,
        expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint!,
        expectedCallerDataEncryptionKey: census.callerDataEncryptionKey!, expectedMetadataVersion: census.content.metadataVersion,
        expectedDaemonStateVersion: census.content.daemonStateVersion,
        recipientKeyEnvelopes: [{ recipientAccountId: member.id,
            encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: guest.machineEncryptionKey,
                recipientPublicKey: keys.publicKey, randomBytes: nacl.randomBytes })),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(keys.publicKey) }],
    }))).toMatchObject({ appliedRecipientAccountIds: [member.id] });
    const memberCredentials = decodeStoredCredentials(encodeStoredCredentials({ token,
        encryption: { type: 'dataKey', machineKey: keys.secretKey, publicKey: keys.publicKey } }));
    if (!memberCredentials) throw new Error('Missing recipient credentials');
    const memberExecute = executeAs(memberCredentials, member.id, true);
    await expect(execute('machines.terminal.write', { ...routing, terminalId,
        event: { t: 'resize', cols: 101, rows: 33 } })).resolves.toMatchObject({ ok: true, result: { ok: true } });
    await expect(execute('machines.terminal.write', { ...routing, terminalId,
        event: { t: 'text', text: 'stty size\n' } })).resolves.toMatchObject({ ok: true, result: { ok: true } });
    await expect(execute('machines.terminal.write', { ...routing, terminalId,
        event: { t: 'text', text: "printf 'a03-'; printf 'public-terminal\\n'\n" } })).resolves.toMatchObject({ ok: true, result: { ok: true } });
    let output = '';
    await expect.poll(async () => {
        const response = await execute('machines.terminal.read', { ...routing, terminalId, byteOffset: 0 });
        if (!response.ok) throw new Error(response.errorCode);
        const read = TerminalStreamReadResponseSchema.parse(response.result);
        if (!read.ok) throw new Error(read.code);
        output = read.frames.filter(frame => frame.t === 'bytes').map(frame =>
            Buffer.from(decodeTerminalStreamBytesFrame(frame)).toString('utf8')).join('');
        return output.includes('a03-public-terminal') && output.includes('33 101');
    }).toBe(true);
    const memberSummary = await memberExecute('machines.work.summary.get', routing);
    expect(memberSummary).toMatchObject({ ok: true, result: { kind: 'current', requesters: [] } });
    expect(JSON.stringify(memberSummary)).not.toContain(terminalId);
    expect(JSON.stringify(memberSummary)).not.toContain(directory);
    expect(JSON.stringify(memberSummary)).not.toContain('a03-public-terminal');
    await expect(executeAs(memberCredentials, member.id)('machines.terminal.read', { ...routing, terminalId, byteOffset: 0 }))
        .resolves.toMatchObject({ ok: false, errorCode: 'requester_credential_disclosure_required' });
    const foreignRead = await memberExecute('machines.terminal.read', { ...routing, terminalId, byteOffset: 0 });
    expect(foreignRead, JSON.stringify(foreignRead)).toMatchObject({ ok: true, result: { ok: false, code: 'terminal_forbidden' } });
    expect(foreignRead).not.toHaveProperty('result.frames');
    const foreignClose = await memberExecute('machines.terminal.close', { ...routing, terminalId });
    expect(foreignClose, JSON.stringify(foreignClose)).toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
    expect(terminals!.getSessionManager().list()).toMatchObject([{ terminalId }]);
    const restarted = await execute('machines.terminal.restart', open);
    expect(restarted, JSON.stringify(restarted)).toMatchObject({ ok: true, result: { ok: true, reused: false } });
    if (!restarted.ok || !restarted.result || typeof restarted.result !== 'object' || Array.isArray(restarted.result)
        || typeof restarted.result.terminalId !== 'string') throw new Error('Missing restarted terminal');
    expect(restarted.result.terminalId).not.toBe(terminalId);
    terminalId = restarted.result.terminalId;
    const closed = await execute('machines.terminal.close', { ...routing, terminalId });
    expect(closed, JSON.stringify(closed)).toMatchObject({ ok: true, result: { ok: true } });
    expect(terminals!.getSessionManager().list()).toEqual([]);
    expect(await db.session.count()).toBe(0);
}, 300_000);
