import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import nacl from 'tweetnacl';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { ManagedAcquireInputV1Schema, type ManagedAcquireInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createManagedMachinePresetAcquireOverrideV1, sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { AcquireResultV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { seedCliDataKeyAuthForServer } from '../../../../../packages/tests/src/testkit/cliAuth';
import { startInterruptibleTcpProxy } from '../../../../../packages/tests/src/testkit/network/interruptibleTcpProxy';
import { createDeploymentSocketHome } from '../../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { createSignedAccountContentBinding } from '../../../../server/sources/testkit/accountEncryption';
import { prepareE2eePrivateLabelForAccount } from '../../../../server/sources/testkit/privateLabelFixture';
import { decodeMachineStoredContent } from '../../../../server/sources/storage/sessionMachineStoredContent';
import { db } from '../../../../server/sources/storage/db';
import { auth } from '../../../../server/sources/app/auth/auth';
import { createMachinePreset, readMachinePresetRecipientCensus } from '../../../../server/sources/app/machines/managed/machinePresetService';
import { createMachinePool } from '../../../../server/sources/app/machines/pools/machinePoolService';
import type { MachineDaemonPresenceSocketServer } from '../../../../server/sources/app/machines/machineDaemonPresence';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import { decodeStoredCredentials, encodeStoredCredentials } from '@/persistence';
import { reloadConfiguration } from '@/configuration';
import { registerCapabilitiesHandlers } from '@/rpc/handlers/capabilities';
import { CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1 } from '@/api/apiMachine';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import * as installationStore from '@/daemon/identity/store';
import { createS0DeploymentDaemonIngress, installationBoundary, readS0Installation } from '@/deployments/deploymentDaemonIngress.composed.testkit';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { acquireEnrollmentJourneyGuest } from './enrollmentJourney.testkit';

// Delegated cap admission/release edge cases remain covered by
// apps/server/sources/app/api/routes/actions/registerExternalActionRoutes.managedOrigination.composed.integration.spec.ts:
// "releases the delegated preset slot when a member deletes canceled uncertain Devcontainer creation through native reconciliation".
// Run this same journey with HAPPIER_MEMBER_JOURNEY_FAULT=missing-payload-root,
// invalid-archive or remote-stderr to falsify its successful enrollment assertion.
const memberJourneys = [
    { name: 'enrolls an unprepared Team preset through the member CLI after the Home route changes', unprepared: true, scenarios: ['exact'] },
    { name: 'enrolls exact and pool Team containers as their member and preserves bootstrap failure causes', unprepared: false,
        scenarios: ['missing-native-option', 'missing-payload-root', 'invalid-archive', 'stderr', 'admin', 'exact', 'pool'] },
] as const;
it.skipIf(process.platform !== 'linux').each(memberJourneys)('$name', async ({ unprepared, scenarios }) => {
    const homeDirectory = await createTempDir('member-container-journey-');
    onTestFinished(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); reloadConfiguration(); await removeTempDir(homeDirectory); });
    vi.stubEnv('HAPPIER_HOME_DIR', homeDirectory);
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
    reloadConfiguration();
    let presence: MachineDaemonPresenceSocketServer;
    const home = await createDeploymentSocketHome({ encryptionMode: 'e2ee',
        prepareMachineContent: (key, metadata) => createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: key,
            encryptionVariant: 'dataKey' }).encodeStored(metadata),
        configureApp: app => {
            if (!app.machineDaemonPresence) throw new Error('The real Home must publish daemon presence');
            presence = app.machineDaemonPresence;
        },
    });
    onTestFinished(() => home.close());
    // Each daemon has its own physical installation file in the real system.
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockImplementation(
        () => installationBoundary.getStore() ?? readS0Installation(home));
    const memberKeys = nacl.box.keyPair();
    const member = await db.account.create({ data: { encryptionMode: 'e2ee',
        ...createSignedAccountContentBinding(memberKeys.publicKey) } });
    const requester = { accountId: member.id,
        token: await auth.createToken(member.id, undefined, { kind: 'account', authority: 'present_user',
            authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }] }),
        encryption: { type: 'dataKey' as const, machineKey: memberKeys.secretKey, publicKey: memberKeys.publicKey } };
    const runRequesterAction = unprepared ? await (async () => {
        const cliHome = await mkdtemp(join(home.baseDir, 'requester-cli-'));
        const token = await auth.createToken(member.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const { serverId } = await seedCliDataKeyAuthForServer({
            cliHome, serverUrl: home.baseUrl, token, machineKey: memberKeys.secretKey,
        });
        // Model a still-reachable former HTTPS ingress. Home has moved its
        // approval route, while the requester's saved descriptor is one revision behind.
        const retiredIngress = await startInterruptibleTcpProxy(home.baseUrl);
        onTestFinished(() => retiredIngress.close());
        const readDescriptor = async () => {
            const response = await fetch(`${home.baseUrl}/v1/features/authenticated`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(response.ok).toBe(true);
            return HomeConnectionDescriptorV1Schema.parse((await response.json()).homeConnectionDescriptor);
        };
        const retiredUrl = retiredIngress.baseUrl.replace(/^http:/, 'https:');
        vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', retiredUrl);
        const savedDescriptor = await readDescriptor();
        vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', home.baseUrl);
        const currentDescriptor = await readDescriptor();
        expect(currentDescriptor.revision).toBeGreaterThan(savedDescriptor.revision);
        expect(savedDescriptor.endpoints).toEqual([{ kind: 'https', url: retiredUrl }]);
        expect(currentDescriptor.endpoints).toEqual([{ kind: 'https', url: home.baseUrl }]);
        const settingsPath = join(cliHome, 'settings.json');
        const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
        settings.servers[serverId].homeConnectionDescriptor = savedDescriptor;
        settings.servers[serverId].homeConnectionDescriptorAuthority = 'exact';
        await writeFile(settingsPath, JSON.stringify(settings));
        const sourceRuntime = fileURLToPath(new URL('../../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url));
        const entry = fileURLToPath(new URL('../../index.ts', import.meta.url));
        return async (actionId: string, input: Record<string, unknown>) => {
            const output = await promisify(execFile)(process.execPath, ['--conditions=happier-source', '--import', sourceRuntime,
                entry, 'actions', 'invoke', actionId, '--input-json', JSON.stringify(input), '--yes', '--json'], {
                env: { ...process.env, HAPPIER_HOME_DIR: cliHome, HAPPIER_SERVER_URL: home.baseUrl, HAPPIER_WEBAPP_URL: home.baseUrl },
            }).catch((error: unknown) => {
                if (typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string' && error.stdout) {
                    return { stdout: error.stdout };
                }
                throw error;
            });
            const envelope = JSON.parse(output.stdout);
            if (!envelope.ok) throw new Error(`${actionId} failed: ${JSON.stringify({ errorCode: envelope.errorCode, error: envelope.error })}`);
            return { ok: true, result: envelope.data };
        };
    })() : undefined;
    const team = await db.team.create({ data: { name: 'Member container journey' } });
    await db.teamMembership.createMany({ data: [
        { teamId: team.id, accountId: home.accountId, role: 'owner' },
        { teamId: team.id, accountId: member.id, role: 'member' },
    ] });
    const seed = nativeFixture({ privateNative: true, credentialPurposes: [] });
    const manifest = { ...seed.manifest, contributes: { ...seed.manifest.contributes,
        machineProvisioners: seed.manifest.contributes.machineProvisioners.map(value => ({ ...value, resourceKind: 'container' })) } };
    seed.retire();
    const poolId = randomUUID();
    const exactId = randomUUID();
    const pooledId = randomUUID();
    const failurePresets = { 'missing-payload-root': randomUUID(), 'invalid-archive': randomUUID(), stderr: randomUUID(), 'missing-native-option': randomUUID() };
    const controller = { machineId: home.machineId, installationId: home.installationId };
    const provider = { pluginId: 'acme.compute', localId: 'vm' };
    const sealedPresets = new Map<string, ReturnType<typeof sealManagedMachinePresetContentV1>>();
    let installed = false;
    const controllerHome = { ...home, async prepareControllerProvisioner(raw: unknown) {
        if (installed) return;
        await home.prepareControllerProvisioner(raw);
        const poolName = await prepareE2eePrivateLabelForAccount(home.accountId,
            { entity: 'machine_pool', field: 'name', id: poolId }, 'Team container controllers', { teamIds: [team.id] });
        const pool = await createMachinePool({ accountId: home.accountId,
            authentication: { authenticationAuthority: 'present_user' }, io: presence,
            input: { poolId, name: poolName, audience: { kind: 'team', teamId: team.id },
                members: [{ machineId: home.machineId, priorityTier: 0, enabled: true }] } });
        expect(pool, pool.ok ? undefined : JSON.stringify(pool.error)).toMatchObject({ ok: true });
        for (const id of [exactId, pooledId, ...Object.values(failurePresets)]) {
            const target = id === pooledId ? { controllerPoolId: poolId } : { controller };
            const census = await readMachinePresetRecipientCensus({ accountId: home.accountId,
                authentication: { authenticationAuthority: 'present_user' },
                input: { homeId: home.serverId, owner: { kind: 'team', teamId: team.id }, ...target } });
            if (census.kind !== 'ready') throw new Error(`Preset census refused: ${census.code}`);
            const sealed = sealManagedMachinePresetContentV1({ presetId: id, mode: 'e2ee',
                content: { v: 1, name: 'Team container', launch: { provider, schemaVersion: 1, name: 'Member container', choices: {} },
                    ...(id === exactId ? { credentialBroker: true } : {}) },
                recipientCensus: census.recipients, randomBytes: nacl.randomBytes });
            sealedPresets.set(id, sealed);
            expect(await createMachinePreset({ accountId: home.accountId,
                authentication: { authenticationAuthority: 'present_user' }, input: {
                    id, homeId: home.serverId, contentEncryptionMode: 'e2ee', content: sealed.content, recipients: sealed.recipients, owner: { kind: 'team', teamId: team.id },
                    ...(id === pooledId ? { controllerPoolId: poolId } : { controller }),
                    teamAcquireDelegated: true, simultaneousLimit: { maximum: 2 },
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                } })).toMatchObject({ kind: 'saved' });
        }
        for (const id of [exactId, pooledId]) {
            const response = await fetch(`${home.baseUrl}/v1/machines/presets/get`, { method: 'POST',
                headers: { Authorization: `Bearer ${requester.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ homeId: home.serverId, id }) });
            expect(response.status).toBe(200);
            const result = await response.json();
            expect(result).toMatchObject({ kind: 'found', preset: { teamAcquireDelegated: true, content: { t: 'encrypted' } } });
            expect(result.preset).not.toHaveProperty('delegatedAcquire');
        }
        expect(await db.machineGrant.count({ where: { machineId: home.machineId, accountId: member.id } })).toBe(0);
        installed = true;
    } };
    await controllerHome.prepareControllerProvisioner(manifest);
    let currentAction: NonNullable<ActionExecutorDeps['managedMachineAction']>;
    const operationProtocolCapabilities = { externalActionExecutionAuthorization:
        CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1.externalActionExecutionAuthorization };
    let ingress: Awaited<ReturnType<typeof createS0DeploymentDaemonIngress>> | undefined;
    const nativeContainers = new Set<string>();
    let payloadTransfers = 0;
    const missingPayload = await mkdtemp(join(home.baseDir, 'missing-payload-'));
    const successful: Array<{ guestId: string; nativeId: string;
        owner: Pick<typeof home, 'accountId' | 'token' | 'encryption'>; action: typeof currentAction }> = [];
    const fault = process.env.HAPPIER_MEMBER_JOURNEY_FAULT;
    for (const scenario of scenarios) {
        const owner = scenario === 'admin' ? home : requester;
        let terminal: ActionOperationSnapshotV1 | undefined;
        const nativeId = randomUUID();
        const commandLines: string[] = [];
        const presetId = scenario === 'pool' ? pooledId : scenario in failurePresets
            ? failurePresets[scenario as keyof typeof failurePresets] : exactId;
        const sealed = sealedPresets.get(presetId)!;
        const recipientEnvelope = sealed.recipients.find(recipient => recipient.accountId === owner.accountId)?.envelope;
        if (!recipientEnvelope || !owner.encryption) throw new Error('Expected preset recipient');
        const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({ presetId, mode: 'e2ee',
            projection: { content: sealed.content, recipientEnvelope }, accountId: owner.accountId, accountKey: owner.encryption.machineKey,
            enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, randomBytes: nacl.randomBytes });
        if (!presetContentOverride) throw new Error('Expected sealed acquisition choices');
        const input = ManagedAcquireInputV1Schema.parse({ ...(unprepared ? {} : { presetContentOverride }),
            selection: { kind: 'preset', homeId: home.serverId,
                id: presetId, revision: 0 },
            ...(unprepared ? {} : {
                ...(scenario === 'pool' ? {} : { controller }), retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            }) });
        const injected = scenario === 'admin' ? fault : scenario;
        const journey = acquireEnrollmentJourneyGuest(controllerHome, { requester: owner,
            ...(runRequesterAction ? { runRequesterAction } : {}),
            acquireInput: input, confirmWholeOperation: true, onSettled: operation => { terminal = operation; },
            native: { manifest, ...(injected === 'missing-payload-root' ? { payloadRoot: missingPayload } : {}),
                async execute(role, body, _context, next) {
                    if (role === 'acquire' && scenario === 'missing-native-option') return AcquireResultV1Schema.parse({
                        kind: 'rejected', code: 'provider_unavailable', nativeCause: { httpStatusClass: '4xx', code: 'not_found' },
                    });
                    if (role === 'acquire') {
                        nativeContainers.add(nativeId);
                        return { kind: 'bound', resource: { contributionRef: provider, schemaVersion: 1, value: { guest: nativeId }, origin: 'created' } };
                    }
                    if (role === 'destroy') { nativeContainers.delete(nativeId); return { kind: 'confirmed' }; }
                    if (role === 'putFile') payloadTransfers++;
                    if (role === 'exec' && body && typeof body === 'object' && !Array.isArray(body) && Array.isArray(body.argv)) {
                        const command = body.argv[2];
                        if (typeof command !== 'string') throw new Error('Missing guest command');
                        commandLines.push(command);
                        if (injected === 'invalid-archive' && command.includes('self __install-payload')) return {
                            termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } },
                            stdoutBase64: '', stderrBase64: Buffer.from(JSON.stringify({ error: 'invalid_payload',
                                message: 'Injected installCli archive is invalid' })).toString('base64'),
                            stdoutTruncated: false, stderrTruncated: false,
                        };
                        if ((scenario === 'stderr' || injected === 'remote-stderr') && /\bauth\b/u.test(command) && /\brequest\b/u.test(command)) return {
                            termination: { observed: { kind: 'exit', exitCode: 42 }, requestedBy: { kind: 'none' } },
                            stdoutBase64: '', stderrBase64: Buffer.from(JSON.stringify({ v: 1, ok: false, kind: 'auth_request',
                                error: { code: 'ERR_BAD_REQUEST', category: 'http_error', status: 409,
                                    message: 'private remote failure detail', token: 'private-guest-token' } })).toString('base64'),
                            stdoutTruncated: false, stderrTruncated: false,
                        };
                    }
                    await next();
                },
            },
            startController: async action => {
                currentAction = action;
                ingress ??= await createS0DeploymentDaemonIngress({ home, operationProtocolCapabilities,
                    managedMachineAction: (...args) => currentAction(...args),
                    configureRpc: async rpc => {
                        registerCapabilitiesHandlers(rpc);
                        return [RPC_METHODS.CAPABILITIES_INVOKE];
                    } });
                return ingress;
            },
            startGuest: async (guest, nativeBoundary) => {
                const receiver = await createS0DeploymentDaemonIngress({ home: guest, nativeBoundary, operationProtocolCapabilities });
                onTestFinished(() => receiver.close());
            },
        });
        if (scenario in failurePresets) {
            await expect(journey).rejects.toThrow('S0 acquisition failed');
            expect(terminal, JSON.stringify(terminal)).toMatchObject({ state: 'failed', error: { failureCause: {
                phase: 'machines.managed.acquire', errorCode: scenario === 'missing-native-option' ? 'provider_unavailable'
                    : scenario === 'missing-payload-root' ? 'guest_payload_missing' : 'remote_command_failed',
            } } });
            if (scenario === 'missing-native-option') {
                expect(terminal?.requestId).toEqual(expect.any(String));
                expect(terminal?.error).toMatchObject({ errorCode: 'provider_unavailable',
                    details: { kind: 'managedNative', nativeCause: { httpStatusClass: '4xx', code: 'not_found' } } });
            }
            if (scenario === 'stderr') {
                expect(terminal?.error?.error).toContain('exit 42');
                expect(terminal?.error?.error).toContain('code ERR_BAD_REQUEST');
                expect(terminal?.error?.error).toContain('category http_error');
                expect(terminal?.error?.error).toContain('HTTP 409');
                expect(JSON.stringify(terminal)).not.toMatch(/private remote failure detail|private-guest-token/);
            }
            ingress = undefined; // The failed journey has retired its own controller.
        } else {
            const guest = await journey.catch(error => { throw new Error(`${scenario} journey failed`, { cause: error }); });
            expect(guest.accountId).toBe(owner.accountId);
            expect(guest.token === owner.token).toBe(true);
            const registered = await db.machine.findUniqueOrThrow({ where: { id: guest.machineId } }).then(decodeMachineStoredContent);
            expect(registered).toMatchObject({ accountId: owner.accountId });
            if (scenario === 'exact') {
                if (!guest.machineEncryptionKey) throw new Error('Expected a key for the enrolled Machine');
                const metadata = createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: guest.machineEncryptionKey,
                    encryptionVariant: 'dataKey' }).decodeStored(registered.metadata);
                expect(metadata).toMatchObject({ rolesV1: { active: expect.arrayContaining(['broker']) } });
            }
            expect(await db.managedMachine.findFirstOrThrow({ where: { enrolledMachineId: guest.machineId } }))
                .toMatchObject({ presetId: scenario === 'pool' ? pooledId : exactId,
                    controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId });
            expect(commandLines.some(command => command.includes('self __install-payload') && command.includes('--payload-root'))).toBe(true);
            successful.push({ guestId: guest.machineId, nativeId, owner, action: currentAction! });
            if (scenario === 'exact' && !unprepared) await verifyCapAndDelete(input);
        }
    }
    expect(await db.machineGrant.count({ where: { machineId: home.machineId, accountId: member.id } })).toBe(0);
    async function verifyCapAndDelete(cappedInput: ManagedAcquireInputV1) {
        expect(payloadTransfers).toBeGreaterThan(0);
        const response = await fetch(`${home.baseUrl}/v1/machines`, { headers: { Authorization: `Bearer ${requester.token}` } });
        expect(response.status).toBe(200);
        const visible = JSON.stringify(await response.json());
        expect(visible).not.toContain(home.machineId);
        expect(visible).not.toContain(successful[0]!.guestId);
        for (const guest of successful.slice(1)) expect(visible).toContain(guest.guestId);
        const memberCredentials = decodeStoredCredentials(encodeStoredCredentials({ token: requester.token, encryption: requester.encryption }));
        if (!memberCredentials) throw new Error('The member requires its real credential');
        const cappedRequestId = randomUUID();
        const cappedTarget = { kind: 'machine' as const, machineId: home.machineId };
        const capped = await dispatchOriginalAccountAction({ actionId: 'machines.managed.acquire', input: cappedInput,
            requestId: cappedRequestId, target: cappedTarget, credentials: memberCredentials,
            serverHttpBaseUrl: home.baseUrl, serverIdentityId: home.serverId,
            invocation: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' },
                presentUserConfirmation: { actionId: 'machines.managed.acquire', requestId: cappedRequestId,
                    inputDigest: computeActionInputApprovalDigestV1('machines.managed.acquire', cappedInput),
                    accountId: requester.accountId, serverId: home.serverId, target: cappedTarget } } });
        expect(capped).toMatchObject({ ok: false, errorCode: 'preset_limit_reached' });
        for (const { guestId, nativeId, owner, action } of successful) {
            currentAction = action;
            const managed = await db.managedMachine.findFirstOrThrow({ where: { enrolledMachineId: guestId } });
            const credentials = decodeStoredCredentials(encodeStoredCredentials({ token: owner.token, encryption: owner.encryption }));
            if (!credentials) throw new Error('The enrolled owner requires its real credential');
            const actionId = 'machines.managed.delete';
            const requestId = randomUUID();
            const target = { kind: 'machine' as const, machineId: home.machineId };
            const input = { homeId: home.serverId, managedId: managed.id, expectedRevision: managed.intentRevision,
                intent: 'delete', when: 'now', reviewedDependencies: true };
            const deletion = await dispatchOriginalAccountAction({ actionId, input, requestId, target, credentials,
                serverHttpBaseUrl: home.baseUrl, serverIdentityId: home.serverId,
                invocation: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' },
                    presentUserConfirmation: { actionId, requestId, inputDigest: computeActionInputApprovalDigestV1(actionId, input),
                        accountId: owner.accountId, serverId: home.serverId, target } } });
            expect(deletion, JSON.stringify(deletion)).toMatchObject({ ok: true, result: { managedId: managed.id } });
            const operations = ingress!.actionOperations;
            const operation = operations.store.list({ accountId: owner.accountId, machineId: home.machineId }).items
                .find(value => value.actionId === actionId && value.domainRef?.kind === 'managedMachine' && value.domainRef.id === managed.id);
            expect(operation).toBeDefined();
            expect(await operations.runner.waitForTerminal({ accountId: owner.accountId, machineId: home.machineId }, operation!.operationId))
                .toMatchObject({ state: 'succeeded' });
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: managed.id } }))
                .toMatchObject({ allocation: 'confirmed-absent' });
            expect(nativeContainers.has(nativeId)).toBe(false);
        }
    }
}, 4 * 300_000);
