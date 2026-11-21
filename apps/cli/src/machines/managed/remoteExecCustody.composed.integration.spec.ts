import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { symbols, type DestinationStream } from 'pino';
import { io } from 'socket.io-client';
import nacl from 'tweetnacl';
import { expect, it, onTestFinished, vi } from 'vitest';
import { MANAGED_EXEC_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { ManagedAcquireInputV1Schema, ManagedExecOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedTargetRequesterV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { ACTION_OPERATION_GET_ACTION_ID_V1, ACTION_OPERATION_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/actions/operations/actionIdsV1';
import { MachineProvisionerNativeExecResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ActionOperationGetV1ResponseSchema, ActionOperationRevisionEphemeralV1Schema,
    ActionOperationSnapshotV1Schema, type ActionOperationRevisionEphemeralV1 } from '@happier-dev/protocol/actions/operations/v1';
import { ExternalActionRequestEnvelopeV2Schema, ExternalActionResponseEnvelopeV2Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { openAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { bindPresentUserActionConfirmationV1 } from '@happier-dev/protocol/actions/executor/approvalReview';
import { buildAccountStoredContentCompatibilitySocketAuthV1, computeContentPublicKeyFingerprint,
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, encodeBase64, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { isRecord } from '@happier-dev/protocol/common/records';
import { createDeploymentSocketHome } from '../../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { createSignedAccountContentBinding } from '../../../../server/sources/testkit/accountEncryption';
import { setEligibleMachineAccessGrantInTx } from '../../../../server/sources/testkit/machineAccessGrant.testkit';
import { registerAutomationActionIndexRoutes } from '../../../../server/sources/app/api/routes/automations/registerAutomationActionIndexRoutes';
import { commitMachineRecipientKeyEnvelopesInTx, readMachineRecipientCensusInTx } from '../../../../server/sources/app/machines/machineAccess';
import { resolveManagedMachineRolesInTx } from '../../../../server/sources/app/machines/managed/managedRows';
import { auth } from '../../../../server/sources/app/auth/auth';
import { db } from '../../../../server/sources/storage/db';
import { inTx } from '../../../../server/sources/storage/inTx';
import { logger as homeLogger } from '../../../../server/sources/utils/logging/log';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import { mintExternalActionExecutionAuthorization } from '@/api/externalActionAuthorizationHttp';
import { configuration, reloadConfiguration } from '@/configuration';
import { createDaemonManagedMachineActionAdapter } from '@/daemon/startup/managedMachineActionAdapter';
import { readManagedMachinePolicyCensus } from '@/daemon/startup/managedMachinePolicyRuntime';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createS0DeploymentDaemonIngress, installationBoundary, readS0ControllerCredentials, readS0Installation } from '@/deployments/deploymentDaemonIngress.testkit';
import * as installationStore from '@/daemon/identity/store';
import { decodeStoredCredentials, encodeStoredCredentials, updateSettings, type StoredCredentials } from '@/persistence';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { fixture as createNativeProvisioner } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import type { CliApprovalRequestedHandler } from '@/session/actions/approvals/deferredResult';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { logger as daemonLogger } from '@/ui/logger';

async function createManagedExecFixture(initialPower: 'running' | 'stopped' = 'running') {
    const directory = await createTempDir('composed-managed-exec-');
    onTestFinished(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); reloadConfiguration(); await removeTempDir(directory); });
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
    reloadConfiguration();
    const wire: unknown[] = [];
    const home = await createDeploymentSocketHome({
        dbProvider: process.env.HAPPIER_DB_PROVIDER === 'postgres' && process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID ? 'postgres' : 'sqlite',
        encryptionMode: 'e2ee',
        prepareMachineContent: (key, metadata) => createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: key,
            encryptionVariant: 'dataKey' }).encodeStored(metadata),
        configureApp: app => {
            registerAutomationActionIndexRoutes(app);
            app.addHook('preHandler', async request => { wire.push(request.body); });
            app.addHook('onSend', async (_request, _reply, payload) => { wire.push(payload); });
        },
    });
    onTestFinished(() => home.close());
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockImplementation(
        () => installationBoundary.getStore() ?? readS0Installation(home));
    const homeLogs: unknown[] = [];
    const stream = Reflect.get(homeLogger, symbols.streamSym) as DestinationStream;
    const writeHomeLog = stream.write.bind(stream);
    vi.spyOn(stream, 'write').mockImplementation(message => { homeLogs.push(message); return writeHomeLog(message); });
    const daemonLogs = (['debug', 'info', 'warn', 'error'] as const).map(method => vi.spyOn(daemonLogger, method));
    const credentials = readS0ControllerCredentials(home);
    const serverId = configuration.activeServerId;
    const controller = { machineId: home.machineId, installationId: home.installationId };
    const target = { kind: 'machine' as const, machineId: home.machineId };
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [serverId]: {
        id: serverId, name: 'Managed command Home', serverUrl: home.baseUrl, webappUrl: home.baseUrl,
        homeConnectionDescriptorAuthority: 'exact',
        homeConnectionDescriptor: { v: 1, homeServerIdentityId: home.serverId, canonicalServerUrl: home.baseUrl,
            revision: 1, endpoints: [{ kind: 'https', url: home.baseUrl }] },
        createdAt: 1, updatedAt: 1, lastUsedAt: 1,
    } } }));

    const canary = (name: string) => `rc5-${name}-${randomUUID()}`;
    const canaries = { argv: canary('argv'), env: canary('env'), stdout: canary('stdout'), stderr: canary('stderr'),
        controller: canary('controller'), provider: canary('provider') };
    vi.stubEnv('RC5_CONTROLLER_ENV', canaries.controller);
    const guestBin = join(directory, 'guest bin');
    await mkdir(guestBin);
    await Promise.all(Object.entries(guestIdentityExecutables(guestBin)).map(([name, script]) =>
        writeFile(join(guestBin, name), script, { mode: 0o755 })));
    const providerService = { pluginId: 'acme.accounts', localId: 'cloud' };
    const providerAccount = { service: providerService, accountId: 'managed-command-provider' };
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected connected Account boundary'); };
    const providerReads: string[] = [];
    const purposeBindingOwner = createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
        selectTarget: unavailable,
        resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Managed command provider' } : null,
        materializeAccount: async ({ account }) => {
            providerReads.push(account.accountId);
            return { kind: 'environment', env: { TOKEN: canaries.provider } };
        },
        projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
    });
    const providerAuthority = createManagedProviderOperationAuthority({
        materializationBaseDir: home.baseDir, purposeBindingOwner,
        requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
        resolveRequestAuthHttpPort: () => 0, createRedactionLease: () => ({ add() {}, close() {} }),
    });
    const nativeCalls: unknown[] = [];
    const powerCalls: unknown[] = [];
    let inspectionsAfterPower = 0;
    const providerLogs: unknown[] = [];
    const results: NonNullable<Parameters<typeof createNativeProvisioner>[0]['nativeRoleResults']> = {
        power: { kind: 'confirmed' },
        // Leave one native read stopped after dispatch, then observe the real controller settle it.
        inspect: () => ({ observedAt: Date.now(), availability: 'present', storage: 'retained',
            power: powerCalls.length > 0 && ++inspectionsAfterPower >= 2 ? 'running' : initialPower }),
    };
    const provisioner = createNativeProvisioner({ privateNative: true, credentialOwner: purposeBindingOwner,
        credentialPurposes: [{ purpose: 'upstream', service: providerService }],
        referenceManifests: [normalizePluginManifestV2({
            schemaVersion: 2, id: providerService.pluginId, version: '1.0.0', displayName: 'Cloud fixture', runtime: { apiVersion: 1 },
            contributes: { connectedAccountDescriptors: [{ id: providerService.localId, title: 'Cloud',
                authentication: { defaultModeId: 'token', modes: [{ id: 'token', kind: 'manual', outcomeReconciliation: 'none',
                    fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }] }] } }] },
        })],
        nativeCommandArgs: [], supportedIntents: ['start', 'stop', 'delete'], nativeRoleResults: results,
        invocationLogSink: { write: entry => { providerLogs.push(entry); } },
        hostServiceAdapters: { exec: {
            resolveExecutable: async () => ({ command: process.execPath, args: [] }),
            resolvePath: async () => { throw new Error('Unexpected provider cwd'); },
            environment: { RC5_CONTROLLER_ENV: canaries.controller },
        } },
        onNativeRole: async (role, input, context) => {
            if (role === 'power') {
                powerCalls.push(input);
                return;
            }
            if (role !== 'exec') return;
            if (!isRecord(input) || !Array.isArray(input.argv) || !input.argv.every(arg => typeof arg === 'string'))
                throw new Error('Expected provider guest argv');
            nativeCalls.push(input);
            const material = await context.services.connectedAccounts.materialize('upstream', { kind: 'environment', keys: ['TOKEN'] });
            expect(material.kind === 'environment' && material.env.TOKEN === canaries.provider).toBe(true);
            const child = await context.services.exec.run({ executable: { kind: 'systemTool', id: 'fixture-node' },
                args: ['-e', guestTransport, '--', ...input.argv],
                ...(typeof input.inputBase64 === 'string' ? { stdin: Buffer.from(input.inputBase64, 'base64') } : {}),
                env: { PATH: [guestBin, '/usr/bin', '/bin'].join(delimiter), USER: 'external' },
                // This provider default would expire a real process. The admitted role's null overrides it.
                timeoutMs: 1 }, { outputDelivery: 'invocation' });
            results.exec = MachineProvisionerNativeExecResultV1Schema.parse({ termination: child.termination,
                stdoutBase64: encodeBase64(child.stdout), stderrBase64: encodeBase64(child.stderr),
                stdoutTruncated: child.stdoutTruncated, stderrTruncated: child.stderrTruncated });
        },
    });
    onTestFinished(() => provisioner.retire());
    await home.prepareControllerProvisioner(provisioner.manifest);
    const readCensus = (managedId: string, signal?: AbortSignal, target?: ManagedTargetRequesterV1) => readManagedMachinePolicyCensus({
        homeId: home.serverId, controller, custodianAccountId: home.accountId,
        privateKey: readS0Installation(home).privateKey, token: credentials.token, serverUrl: home.baseUrl,
        managedId, target, signal,
    });
    const readTargetCensus = (managedId: string, requester: ManagedTargetRequesterV1) => readCensus(managedId, undefined, requester);
    const driver = createDaemonManagedMachineActionAdapter({ credentials, controllerCredentials: credentials,
        machineId: home.machineId, serverId: home.serverId, serverBaseUrl: home.baseUrl,
        installationIdentity: { installationId: home.installationId, privateKey: home.keys.secretKey },
        managedProviderOperationAuthority: providerAuthority,
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home.serverId, machineId: home.machineId }),
        readPolicyCurrent: async (managedId, signal) => (await readCensus(managedId, signal)).machines[0] ?? null,
        acquireRuntimeRegistryLease: async () => ({ registry: provisioner.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
    });
    const daemon = await createS0DeploymentDaemonIngress({ home, managedMachineAction: driver,
        observeReceivedRequest: async request => { wire.push(request.params); },
        observeOperationPublication: content => { wire.push(content); } });
    onTestFinished(() => daemon.close());
    const cliFor = (creds: StoredCredentials, onApprovalRequested?: CliApprovalRequestedHandler) => createCliActionExecutorFromCredentials({ credentials: creds,
        onApprovalRequested,
        readCredentials: async () => creds, externalActionClient: true, machineId: home.machineId,
        serverId, serverIdentityId: home.serverId, serverApiUrl: home.baseUrl });
    const context = () => ({ surface: 'cli' as const, authority: 'present_user' as const, serverId,
        externalActionTarget: target, actionRequestId: randomUUID() });
    const owner = cliFor(credentials);
    const scope = { serverId: home.serverId, machineId: home.machineId };
    expect(await owner.execute(ACTION_OPERATION_LIST_ACTION_ID_V1, scope, context())).toMatchObject({ ok: true, result: { items: [] } });

    const guestKey = nacl.randomBytes(32);
    const guest = await db.machine.create({ data: { id: randomUUID(), accountId: home.accountId, active: false,
        metadata: createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: guestKey, encryptionVariant: 'dataKey' })
            .encodeStored({ host: 'Offline guest', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier' }),
        dataEncryptionKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: guestKey, recipientPublicKey: home.encryption!.publicKey,
            randomBytes: nacl.randomBytes }), installationId: randomUUID(), installationPublicKey: nacl.sign.keyPair().publicKey } });
    const identity = { kind: 'dedicatedDaemonUser' as const, username: 'happier' as const, serviceMode: 'user' as const,
        role: 'deployTarget' as const, adminAccessAtCreation: 'none' as const };
    const contributionRef = { pluginId: provisioner.manifest.id, localId: 'vm' };
    const launch = { provider: contributionRef, schemaVersion: 1, name: 'Retained guest', choices: {},
        credentials: [{ purpose: { consumer: contributionRef, purpose: 'upstream' }, account: providerAccount }] };
    const retention = { kind: 'until-delete' as const };
    const retainGuest = (enrolledMachineId: string, enrollmentIdentity: typeof identity | { kind: 'existingUser'; role: 'adopted' }) => {
        const acquire = ManagedAcquireInputV1Schema.parse({ enrollmentIdentity, selection: {
            kind: 'one-off', homeId: home.serverId, controller, launch, retention, wakeOnAcceptedMessage: false,
        } });
        return db.managedMachine.create({ data: { homeId: home.serverId, custodianAccountId: home.accountId,
            controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            admittedActionRequestId: randomUUID(), admittedInput: { computeInput: acquire, enrollmentAccountId: home.accountId },
            launch, allocation: 'bound', resource: { contributionRef, schemaVersion: 1, value: {} }, enrolledMachineId,
            desired: initialPower === 'stopped' ? 'stop' : 'start',
            observation: { observedAt: Date.now(), availability: 'present', storage: 'retained', power: initialPower },
            retention, wakeOnAcceptedMessage: false } });
    };
    const adoptedGuest = await db.machine.create({ data: { id: randomUUID(), accountId: home.accountId, active: false,
        metadata: guest.metadata, dataEncryptionKey: guest.dataEncryptionKey,
        installationId: randomUUID(), installationPublicKey: nacl.sign.keyPair().publicKey } });
    const managed = await retainGuest(guest.id, identity);
    const adopted = await retainGuest(adoptedGuest.id, { kind: 'existingUser', role: 'adopted' });
    const member = async (level: 'admin' | 'view') => {
        const keys = nacl.box.keyPair();
        const account = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user',
            authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }] });
        expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: home.accountId, machineId: guest.id,
            principal: { kind: 'account', accountId: account.id }, level }))).toMatchObject({ kind: 'saved' });
        const census = await inTx(tx => readMachineRecipientCensusInTx(tx, { actorAccountId: home.accountId, machineId: guest.id }));
        if ('kind' in census || !census.callerDataEncryptionKey || !census.machineOwnerEnvelopeFingerprint)
            throw new Error('Expected the paired guest key recipient census');
        expect(await inTx(tx => commitMachineRecipientKeyEnvelopesInTx(tx, {
            actorAccountId: home.accountId, machineId: guest.id, expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint!,
            expectedCallerDataEncryptionKey: census.callerDataEncryptionKey!, expectedMetadataVersion: census.content.metadataVersion,
            expectedDaemonStateVersion: census.content.daemonStateVersion, recipientKeyEnvelopes: [{ recipientAccountId: account.id,
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(keys.publicKey),
                encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
                    dataKey: guestKey, recipientPublicKey: keys.publicKey, randomBytes: nacl.randomBytes })) }],
        }))).toMatchObject({ appliedRecipientAccountIds: [account.id] });
        const credentials = decodeStoredCredentials(encodeStoredCredentials({
            token, encryption: { type: 'dataKey', machineKey: keys.secretKey, publicKey: keys.publicKey },
        }));
        if (!credentials) throw new Error('Expected stored requester credentials');
        return { accountId: account.id, tokenEpoch: account.tokenEpoch, credentials, cli: cliFor(credentials) };
    };
    const requester = await member('admin');
    const other = await member('admin');
    const use = await member('view');
    const input = { homeId: home.serverId, managedId: managed.id,
        argv: ['/bin/sh', '-c',
            'id -un; pwd; /usr/bin/env | /usr/bin/grep -E "^(RC5_REQUEST_ENV|RC5_CONTROLLER_ENV|TOKEN)="; printf "%s\\n" "$1" "$2"; printf "%s\\n" "$3" >&2; exit 3',
            'fixture', canaries.argv, canaries.stdout, canaries.stderr], cwd: guestBin, env: { RC5_REQUEST_ENV: canaries.env } };
    return { home, credentials, owner, requester, other, use, cliFor, context, scope, target, input,
        managed, adopted, guest, guestBin, canaries, daemon, readTargetCensus, nativeCalls, powerCalls, providerReads,
        providerAccount, wire, homeLogs, daemonLogs, providerLogs };
}

it.runIf(process.platform === 'linux')('asks before a guest Manage CLI command and refuses guest Use before Ask', async () => {
    const { home, target, input, requester, use, context, cliFor, nativeCalls, providerReads, providerAccount } =
        await createManagedExecFixture();
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    // Home receives an opaque envelope; both probes carry the same exact target projection.
    const material = { type: 'dataKey' as const, machineKey: nacl.randomBytes(32) };
    const mint = (actor: typeof requester) => mintExternalActionExecutionAuthorization({
        actionId: MANAGED_EXEC_ACTION_ID_V1, machineId: target.machineId,
        pat: actor.credentials.token, serverHttpBaseUrl: home.baseUrl,
        envelope: sealExternalActionRequestV2({ binding: { actionId: MANAGED_EXEC_ACTION_ID_V1,
            accountId: actor.accountId, serverIdentityId: home.serverId, requestId: randomUUID(), target,
            authentication: { kind: 'account', tokenEpoch: actor.tokenEpoch },
        }, input, material, randomBytes: nacl.randomBytes, projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 }),
    });
    expect.soft(await mint(requester)).toMatchObject({ ok: true });
    expect.soft(await mint(use)).toMatchObject({ ok: false, code: 'target_unavailable' });
    const usePresenter = vi.fn<CliApprovalRequestedHandler>();
    const refused = await cliFor(use.credentials, usePresenter).execute(MANAGED_EXEC_ACTION_ID_V1, input, context());
    expect.soft(refused, JSON.stringify(refused)).toMatchObject({ ok: false, errorCode: 'controller_unavailable', effectAttempted: false });
    expect(usePresenter).not.toHaveBeenCalled();
    expect(await db.artifact.count({ where: { accountId: use.accountId } })).toBe(0);
    expect(nativeCalls).toHaveLength(0);
    expect(providerReads).toHaveLength(0);

    const askOwners: Array<{ accountId: string }> = [];
    const presenter = vi.fn<CliApprovalRequestedHandler>(async (artifactId, _signal, decide) => {
        askOwners.push(...await db.artifact.findMany({ where: { id: artifactId }, select: { accountId: true } }));
        expect(nativeCalls).toHaveLength(0);
        expect(providerReads).toHaveLength(0);
        return await decide('approve');
    });
    const execution = await cliFor(requester.credentials, presenter).execute(MANAGED_EXEC_ACTION_ID_V1, input, context());
    expect.soft(execution, JSON.stringify(execution)).toMatchObject({ ok: true, result: { exitCode: 3 } });
    expect.soft(presenter).toHaveBeenCalledTimes(1);
    expect.soft(askOwners).toEqual([{ accountId: requester.accountId }]);
    expect.soft(nativeCalls).toHaveLength(1);
    expect(providerReads).toEqual([providerAccount.accountId]);
}, 120_000);

it.runIf(process.platform === 'linux')('wakes the stopped guest after requester CLI Ask while its daemon stays offline', async () => {
    const { input, requester, cliFor, context, managed, guest, nativeCalls, powerCalls } = await createManagedExecFixture('stopped');
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    const presenter = vi.fn<CliApprovalRequestedHandler>(async (_artifactId, _signal, decide) => {
        expect(powerCalls).toHaveLength(0);
        expect(nativeCalls).toHaveLength(0);
        return await decide('approve');
    });
    const execution = await cliFor(requester.credentials, presenter).execute(MANAGED_EXEC_ACTION_ID_V1, input, context());
    expect(execution, JSON.stringify(execution)).toMatchObject({ ok: true, result: { exitCode: 3 } });
    expect(presenter).toHaveBeenCalledTimes(1);
    expect(powerCalls).toMatchObject([{ intent: 'start' }]);
    expect(nativeCalls).toHaveLength(1);
    expect(await db.managedMachine.findUniqueOrThrow({ where: { id: managed.id } })).toMatchObject({
        desired: 'start', observation: { power: 'running' },
    });
    expect(await db.machine.findUniqueOrThrow({ where: { id: guest.id }, select: { active: true } })).toEqual({ active: false });
}, 120_000);

it.runIf(process.platform === 'linux')('keeps managed command input and output private to the requesting Account with the guest daemon offline', async () => {
    const { home, credentials, owner, requester, other, use, context, scope, target, input, managed, adopted, guest, guestBin,
        canaries, daemon, readTargetCensus, nativeCalls, providerReads, providerAccount, wire, homeLogs, daemonLogs, providerLogs } =
        await createManagedExecFixture();
    const watchActivity = async (token: string) => {
        const activity: ActionOperationRevisionEphemeralV1[] = [];
        const socket = io(home.baseUrl, { path: '/v1/updates', transports: ['websocket'], autoConnect: false, reconnection: false,
            auth: { token, clientType: 'user-scoped',
                ...buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) } });
        onTestFinished(() => { socket.close(); });
        socket.on('ephemeral', message => {
            const parsed = ActionOperationRevisionEphemeralV1Schema.safeParse(message);
            if (parsed.success) activity.push(parsed.data);
        });
        await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('connect_error', reject);
            socket.connect();
        });
        return activity;
    };
    const [ownerActivity, otherActivity] = await Promise.all([watchActivity(credentials.token), watchActivity(other.credentials.token)]);
    expect(await inTx(tx => resolveManagedMachineRolesInTx(tx, managed, requester.accountId)))
        .toMatchObject({ resourceRole: 'use', guestActivityRole: 'manage' });
    expect(await inTx(tx => resolveManagedMachineRolesInTx(tx, managed, use.accountId)))
        .toMatchObject({ guestActivityRole: 'use' });
    const placementRequester = { requesterAccountId: use.accountId, committedSessionId: randomUUID() };
    expect(await readTargetCensus(managed.id, placementRequester)).toMatchObject({ targetAdmitted: true });
    const run = (cli: typeof owner, accountId: string, options: { actionRequestId?: string; managedId?: string } = {}) => {
        const request = { ...input, managedId: options.managedId ?? input.managedId };
        return cli.execute(MANAGED_EXEC_ACTION_ID_V1, request, bindPresentUserActionConfirmationV1(MANAGED_EXEC_ACTION_ID_V1, request, {
            ...context(), actionRequestId: options.actionRequestId ?? randomUUID(), actionCaller: { kind: 'host' },
            runtimeAccountId: accountId, serverIdentityId: home.serverId,
        }));
    };
    const get = (cli: typeof owner, operationId: string) => cli.execute(ACTION_OPERATION_GET_ACTION_ID_V1,
        { ...scope, operationId, waitForTerminal: true }, context());
    const runUi = (actor: typeof requester, requestId: string) => dispatchOriginalAccountAction({
        actionId: MANAGED_EXEC_ACTION_ID_V1, input, target, requestId, credentials: actor.credentials,
        serverIdentityId: home.serverId, serverHttpBaseUrl: home.baseUrl,
        invocation: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' },
            presentUserConfirmation: { actionId: MANAGED_EXEC_ACTION_ID_V1, requestId, target,
                inputDigest: computeActionInputApprovalDigestV1(MANAGED_EXEC_ACTION_ID_V1, input),
                accountId: actor.accountId, serverId: home.serverId } },
    });
    const refused = await runUi(use, randomUUID());
    expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, errorCode: 'controller_unavailable', effectAttempted: false });
    expect(nativeCalls).toHaveLength(0);
    expect(providerReads).toHaveLength(0);
    const cliCheck = await run(requester.cli, requester.accountId);
    expect(cliCheck, JSON.stringify(cliCheck)).toMatchObject({ ok: true, result: { exitCode: 3 } });
    const actionRequestId = randomUUID();
    const executed = await runUi(requester, actionRequestId);
    expect(executed, JSON.stringify(executed)).toMatchObject({ ok: true });
    if (!executed.ok) return;
    const output = ManagedExecOutputV1Schema.parse(executed.result);
    expect(output).toMatchObject({
        exitCode: 3, stdout: expect.stringContaining(canaries.stdout), stderr: `${canaries.stderr}\n`,
        stdoutTruncated: false, stderrTruncated: false,
    });
    expect(output.stdout).toContain(`RC5_REQUEST_ENV=${canaries.env}\n`);
    expect(output.stdout).toContain(`${canaries.argv}\n`);
    expect(output.stdout).toContain(`${guestBin}\n`);
    expect(output.stdout).toMatch(/^happier\n/);
    expect(wire.some(message => {
        const request = ExternalActionRequestEnvelopeV2Schema.safeParse(isRecord(message) ? message.envelope : null);
        return request.success && request.data.requestId === actionRequestId;
    })).toBe(true);
    expect(wire.some(message => {
        if (typeof message !== 'string' || !message.startsWith('{')) return false;
        const response = ExternalActionResponseEnvelopeV2Schema.safeParse(JSON.parse(message));
        return response.success && response.data.actionId === MANAGED_EXEC_ACTION_ID_V1 && response.data.requestId === actionRequestId;
    })).toBe(true);
    // Observe the ID from the serving daemon since successful execution
    // returns the command result directly.
    const operation = daemon.actionOperations.store.list({ accountId: requester.accountId, machineId: home.machineId })
        .items.find(item => item.requestId === actionRequestId);
    if (!operation) throw new Error('Expected the requester-owned command operation');
    expect(await owner.execute(ACTION_OPERATION_LIST_ACTION_ID_V1, scope, context()))
        .toMatchObject({ ok: true, result: { items: [] } });
    const ownerRequestId = randomUUID();
    const ownerExecuted = await run(owner, home.accountId, { actionRequestId: ownerRequestId });
    expect(ownerExecuted).toMatchObject({ ok: true, result: { exitCode: 3, stdout: expect.stringMatching(/^happier\n/) } });
    const adoptedExecuted = await run(owner, home.accountId, { managedId: adopted.id });
    expect(adoptedExecuted).toMatchObject({ ok: true, result: { exitCode: 3, stdout: expect.stringMatching(/^external\n/) } });
    const ownerMaterial = credentials.encryption;
    if (!ownerMaterial) throw new Error('Expected controller Account encryption material');
    const openedActivity = () => ownerActivity.map(({ content }) => ActionOperationSnapshotV1Schema.parse(content.t === 'encrypted'
        ? openAccountScopedBlobCiphertext({ kind: 'action_operation_snapshot', material: ownerMaterial, ciphertext: content.c })?.value
        : content.v));
    await expect.poll(() => openedActivity().some(item => item.requestId === ownerRequestId && item.state === 'succeeded')).toBe(true);
    expect(openedActivity().map(item => item.operationId)).not.toContain(operation.operationId);
    expect(otherActivity).toEqual([]);
    expect(nativeCalls).toHaveLength(4);
    expect(providerReads).toEqual(Array(4).fill(providerAccount.accountId));
    expect(await db.machine.findUniqueOrThrow({ where: { id: guest.id }, select: { active: true } })).toEqual({ active: false });

    const [read, custodianRead, otherRead] = await Promise.all([requester.cli, owner, other.cli]
        .map(cli => get(cli, operation.operationId)));
    const accountIds = [home.accountId, requester.accountId, other.accountId, use.accountId];
    daemonLogger.flushSync();
    const logs = await readdir(configuration.logsDir, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    const sinks = {
        'Home wire': wire,
        'Home Activity transport': [ownerActivity, otherActivity],
        'Home logs': homeLogs,
        'daemon logs': [daemonLogs.flatMap(log => log.mock.calls), providerLogs,
            ...await Promise.all(logs.filter(entry => entry.isFile()).map(entry => readFile(join(configuration.logsDir, entry.name), 'utf8')))],
        'Home managed rows': await db.managedMachine.findMany({ where: { controllerMachineId: home.machineId } }),
        'Home approval artifacts': await db.artifact.findMany({ where: { accountId: { in: accountIds } } }),
        'Home Activity': [await db.userFeedItem.findMany({ where: { userId: { in: accountIds } } }),
            await db.accountChange.findMany({ where: { accountId: { in: accountIds } } }),
            await db.session.findMany({ where: { accountId: { in: accountIds } } })],
    };
    for (const [name, value] of Object.entries(sinks)) {
        const serialized = JSON.stringify(value, (_key, field) =>
            typeof field === 'bigint' ? field.toString() : field instanceof Uint8Array ? Buffer.from(field).toString('utf8') : field);
        for (const [label, canary] of Object.entries(canaries))
            expect(serialized?.includes(canary), `${name} contains the ${label} canary`).toBe(false);
    }
    for (const effect of [cliCheck, executed, ownerExecuted, adoptedExecuted]) {
        expect(JSON.stringify(effect)).not.toContain(canaries.controller);
        expect(JSON.stringify(effect)).not.toContain(canaries.provider);
    }
    expect(read, JSON.stringify(read)).toMatchObject({ ok: true });
    const result = read?.ok ? ActionOperationGetV1ResponseSchema.parse(read.result) : null;
    expect(result).toMatchObject({ kind: 'found', operation: { actionId: MANAGED_EXEC_ACTION_ID_V1, state: 'succeeded',
        scope: { accountId: requester.accountId, machineId: home.machineId }, result: output } });
    for (const concealed of [custodianRead, otherRead]) {
        expect(concealed).toMatchObject({ ok: true, result: { kind: 'not_found' } });
    }
}, 120_000);

// Replace the provider's guest process boundary. The transport still feeds
// the controller-generated guest script and captures the real guest child.
const guestTransport = `
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const [command, ...args] = process.argv.slice(1);
if (!process.env.RC5_CONTROLLER_ENV) process.exit(126);
const env = { PATH: process.env.PATH, USER: process.env.USER };
const guest = spawnSync(command, args, { input: readFileSync(0), env, encoding: 'utf8' });
process.stdout.write(guest.stdout ?? '');
process.stderr.write(guest.stderr ?? '');
process.exit(guest.status ?? 125);
`;

function guestIdentityExecutables(bin: string) {
    return {
        id: '#!/bin/sh\ncase "$*" in "-u happier") echo 1001 ;; "-u") if [ "$USER" = happier ]; then echo 1001; else echo 0; fi ;; "-un") echo "$USER" ;; *) exit 1 ;; esac\n',
        getent: '#!/bin/sh\ntest "$*" = "passwd happier" && echo "happier:x:1001:1001::/home/happier:/bin/sh"\n',
        runuser: '#!/bin/sh\n[ "$1" = -u ] && [ "$2" = happier ] && [ "$3" = -- ] || exit 1\nshift 3\nUSER=happier exec "$@"\n',
        // Keep guest OS fixtures visible after the dedicated identity clears
        // the inherited environment and assigns its fixed PATH.
        env: '#!' + process.execPath + '\n' + `
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const path = ${JSON.stringify('PATH=' + [bin, '/usr/bin', '/bin'].join(delimiter))};
const guest = spawnSync('/usr/bin/env', args.map(arg => args[0] === '-i' && arg.startsWith('PATH=') ? path : arg),
    { stdio: 'inherit', env: process.env });
process.exit(guest.status ?? 125);
`,
    };
}
