import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readNativeSshTaskCredentials, runNativeRemoteSshBootstrapTask } from './nativeTask';

import type { SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import type { NativeSshModule } from '@happier-dev/ssh-native';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ManagedMachineEnrollmentIdentityV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { checkMachineSetupEffectPlan, applyMachineSetupEffectPlans, type MachineSetupBackend } from '@happier-dev/cli-common/machineSetup';
import { MachineEffectInternalRequestSchema, MachineAdministratorEstablishFrameSchema } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { firstPartyRuntime } from '@happier-dev/cli-common';
import { createCliPayloadFixture } from '../../../../../../packages/cli-common/src/systemTasks/testkit/createCliPayloadFixture.js';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createNativeSshHomePayload, isNativeSshArchivePromotion, readNativeSshPayloadProcessResult } from './nativeSshHomePayload.testkit';

const HOME_TARGET = {
    profileId: 'home-profile',
    homeServerIdentityId: 'srv_home_identity',
    descriptor: {
        v: 1 as const,
        homeServerIdentityId: 'srv_home_identity',
        canonicalServerUrl: 'https://relay.example.test',
        revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://relay.example.test' }],
    },
    canonicalAuthUrl: 'https://relay.example.test',
    applicationUrl: 'https://relay.example.test',
    webappUrl: 'https://relay.example.test',
    credentialDestination: {
        v: 1 as const,
        homeServerIdentityId: 'srv_home_identity',
        canonicalServerUrl: 'https://relay.example.test',
        applicationEndpointUrls: ['https://relay.example.test'],
        irohEndpointIds: [],
    },
    preferredTransport: 'https' as const,
    authority: 'saved_profile' as const,
};

const REMOTE_PUBLIC_KEY = Buffer.alloc(32, 3).toString('base64');
const PAIRING_SECRET = Buffer.alloc(32, 7).toString('base64url');

function readInstallationTextResult(command: string) {
    if (command.includes('uname -s')) {
        return { status: 0, stdout: JSON.stringify({ platform: 'linux', arch: 'x86_64' }), stderr: '' };
    }
    return readNativeSshPayloadProcessResult(command);
}

async function prepareApprovalBoundary(serverUrl: string, runtimeOrigin = serverUrl) {
    const browser = await installBrowserRuntimeForTests({ url: serverUrl });
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const homePayload = createNativeSshHomePayload(serverUrl);
    const machineKey = new Uint8Array(32).fill(5);
    const publicKey = (await import('tweetnacl')).default.box.keyPair.fromSecretKey(machineKey).publicKey;
    const storedCredentials = {
        token: createAccountTokenForTests('native-task-owner', { currentAccount: true }),
        encryption: { publicKey: Buffer.from(publicKey).toString('base64'), machineKey: Buffer.from(machineKey).toString('base64') },
    };
    const encryption = await createEncryptionFromAuthCredentials(storedCredentials);
    const contentKey = (await import('tweetnacl')).default.box.keyPair.fromSecretKey(encryption.getContentPrivateKey()).publicKey;
    const currentness = { mode: 'e2ee', version: 1, updatedAt: 0, signingKeyFingerprint: null,
        contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(contentKey),
        recipientEnvelopeReadiness: { status: 'available' } };
    const approvals: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    setRuntimeFetch(async (url, init) => {
        const target = new URL(String(url));
        if (target.origin !== new URL(runtimeOrigin).origin && target.origin !== new URL(serverUrl).origin) {
            throw new Error(`Unexpected approval origin: ${target.origin}`);
        }
        if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
        if (target.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({
            capabilities: { serverIdentity: { serverIdentityId: HOME_TARGET.homeServerIdentityId }, guestCli: homePayload.guestCli },
        }));
        if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 0 });
        if (target.pathname === '/v1/account/encryption/currentness') return Response.json(currentness);
        if (target.pathname === '/v1/auth/request/status') return Response.json({ status: 'pending', supportsV2: true });
        if (target.pathname === '/v1/auth/response') {
            approvals.push({ url: String(url), authorization: new Headers(init?.headers).get('Authorization'), body: JSON.parse(String(init?.body)) });
            return Response.json({ success: true });
        }
        return homePayload.fetch(url);
    });
    const profile = await upsertAndActivateServer({ serverUrl });
    await setServerProfileIdentityForUrl(serverUrl, HOME_TARGET.homeServerIdentityId);
    expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: profile.id }, storedCredentials)).toBe(true);
    const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
    return { profile, credentials, storedCredentials, approvals, dispose() { credentials.mockRestore(); resetRuntimeFetch(); browser.restore(); } };
}

function completeRemoteEnrollment(
    options: Readonly<{ onStdoutChunk?: (text: string) => void }>,
    input: Readonly<{
        homeServerIdentityId?: string;
        publicKey?: string;
        createdAtMs?: number;
        expiresAtMs?: number;
    }> = {},
) {
    const homeServerIdentityId = input.homeServerIdentityId ?? HOME_TARGET.homeServerIdentityId;
    const request = JSON.stringify({
        kind: 'remote_home_enrollment_pairing_request',
        protocolVersion: 1,
        publicKey: input.publicKey ?? REMOTE_PUBLIC_KEY,
        homeServerIdentityId,
        pairing: {
            secretB64Url: PAIRING_SECRET,
            createdAtMs: input.createdAtMs ?? Date.now(),
            expiresAtMs: input.expiresAtMs ?? Date.now() + 60_000,
        },
        supportsTokenOnly: true,
        pairingRequirement: 'v3',
    });
    const result = JSON.stringify({
        kind: 'remote_home_enrollment_result',
        protocolVersion: 1,
        success: true,
        homeServerIdentityId,
        machineId: 'machine-paired',
        encryptionType: 'tokenOnly',
        pairingAuthentication: 'v3',
        remoteProfileId: 'remote-home-profile',
    });
    const stdout = `${request}\n${result}\n`;
    options.onStdoutChunk?.(stdout);
    return { status: 0, stdout, stderr: '' };
}

function createRemoteBootstrapSpec(overrides: Partial<SystemTaskSpec> = {}): SystemTaskSpec {
    return {
        protocolVersion: 1,
        kind: 'remote.ssh.bootstrapMachine.v1',
        params: {
            remoteHostId: 'host-a',
            ssh: {
                target: 'dev@10.0.0.5',
                port: 2222,
                auth: 'password',
                password: 'secret',
            },
            relay: {
                relayUrl: 'https://relay.example.test',
                webappUrl: 'http://localhost.:3005',
            },
            channel: 'stable',
            serviceMode: 'none',
            knownHostsMode: 'app',
        },
        ...overrides,
    };
}

describe('runNativeRemoteSshBootstrapTask', () => {
    beforeEach(() => setRuntimeFetch(createNativeSshHomePayload(HOME_TARGET.applicationUrl).fetch));
    afterEach(() => resetRuntimeFetch());

    it.each(['none', 'ask'] as const)('runs admitted dedicated %s CHECK and APPLY through native SSH', async (adminAccessAtCreation) => {
        const identity = ManagedMachineEnrollmentIdentityV1Schema.parse({
            kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'deployTarget', adminAccessAtCreation,
            ...(adminAccessAtCreation === 'ask' ? { administrator: { username: 'operator' } } : {}),
        });
        const spec = createRemoteBootstrapSpec({ params: {
            ...createRemoteBootstrapSpec().params as Record<string, unknown>,
            enrollmentIdentity: identity, serviceMode: 'user',
        } });
        const taskId = 'native-admitted-dedicated';
        const password = 'transient-native-administrator';
        const phases: string[] = [];
        const commands: string[] = [];
        const events: unknown[] = [];
        const applied = new Set<string>();
        let administratorEstablished = false;
        const stdoutListeners = new Set<Parameters<NonNullable<NativeSshModule['addListener']>>[1]>();
        // The native command channel is the OS boundary; task, IPC and interpreter remain real.
        const backend: MachineSetupBackend = {
            observe: async step => {
                const facts: Awaited<ReturnType<MachineSetupBackend['observe']>>['facts'] = step.kind === 'user'
                    ? applied.has(step.id) ? { present: true, username: step.username, uid: 1002 } : { present: false } : {};
                return { stepId: step.id, status: applied.has(step.id) ? 'satisfied' : 'drifted', facts };
            },
            apply: async step => {
                const createdUser = step.kind === 'user' && !applied.has(step.id);
                applied.add(step.id);
                return createdUser ? { createdUser: true } : undefined;
            },
            establishAdministrator: async credential => {
                expect(new TextDecoder().decode(credential.password)).toBe(password);
                administratorEstablished = true;
            },
        };
        const nativeModule = {
            getAvailability: () => ({ available: true, platform: 'android', engine: 'russh', moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true, supportsPersistentHostKeyStorage: false } as const),
            addListener: (eventName, listener) => {
                if (eventName === 'stdout') stdoutListeners.add(listener);
                return { remove: () => { stdoutListeners.delete(listener); } };
            },
            cancelRequest: vi.fn(async () => undefined),
            exec: async request => {
                commands.push(request.command);
                const payloadCommand = readNativeSshPayloadProcessResult(request.command);
                if (payloadCommand) return { exitCode: payloadCommand.status, stdout: payloadCommand.stdout, stderr: payloadCommand.stderr };
                if (request.input) {
                    const [requestLine, credentialLine] = request.input.trimEnd().split('\n');
                    const frame = MachineEffectInternalRequestSchema.parse(JSON.parse(requestLine!));
                    phases.push(frame.mode);
                    if (frame.mode === 'check' && 'steps' in frame) {
                        expect(frame.basis).toMatchObject({ kind: 'sshBootstrap', operationId: taskId });
                        expect(credentialLine).toBeUndefined();
                        const plan = await checkMachineSetupEffectPlan({ basis: frame.basis, steps: frame.steps, backend });
                        return { exitCode: 0, stdout: JSON.stringify({ type: 'result', result: { status: 'checked', plan } }) + '\n', stderr: '' };
                    }
                    if (frame.mode !== 'apply' || !('plans' in frame)) throw new Error('Expected reviewed native Apply');
                    expect(frame.plans[0]?.plan.basis).toMatchObject({ kind: 'sshBootstrap', operationId: taskId });
                    const establishment = credentialLine ? MachineAdministratorEstablishFrameSchema.parse(JSON.parse(credentialLine)) : undefined;
                    expect(Boolean(establishment)).toBe(adminAccessAtCreation === 'ask');
                    if (establishment) expect(establishment).toMatchObject({ operationId: taskId, username: 'operator' });
                    const result = await applyMachineSetupEffectPlans({ plans: frame.plans, backend,
                        ...(establishment ? { administratorEstablishment: { stepId: establishment.stepId,
                            username: establishment.username, password: new TextEncoder().encode(establishment.password) } } : {}),
                    });
                    const stdout = JSON.stringify({ type: 'progress', stepId: 'native-dedicated-ready', phase: 'verify', status: 'satisfied' }) + '\n'
                        + JSON.stringify({ type: 'result', result }) + '\n';
                    for (const listener of stdoutListeners) {
                        listener({ requestId: request.requestId, chunk: stdout.slice(0, 13) });
                        listener({ requestId: request.requestId, chunk: stdout.slice(13) });
                    }
                    return { exitCode: 0, stdout, stderr: '' };
                }
                if (request.command === 'uname -s') return { exitCode: 0, stdout: 'Linux\n', stderr: '' };
                if (request.command.includes('/etc/os-release')) return { exitCode: 0, stdout: 'ubuntu\nnoble\namd64\n', stderr: '' };
                if (request.command === 'id -u happier') return { exitCode: 0, stdout: '1001\n', stderr: '' };
                if (request.command.includes('useradd --create-home')) return { exitCode: 0, stdout: '', stderr: '' };
                const installation = readInstallationTextResult(request.command);
                if (installation) return { exitCode: installation.status, stdout: installation.stdout, stderr: installation.stderr };
                if (request.command.includes('daemon status')) return { exitCode: 0,
                    stdout: JSON.stringify({ daemon: { running: true, healthy: true }, service: { installed: true },
                        auth: { needsAuth: false, credentialState: 'valid', machineRegistrationState: 'server-confirmed',
                            machineId: 'native-dedicated-machine' } }), stderr: '' };
                return { exitCode: 0, stdout: JSON.stringify({ ok: true, data: request.command.includes('auth status')
                    ? { authenticated: true, credentialState: 'valid', machineRegistered: true,
                        machineRegistrationState: 'server-confirmed', machineId: 'native-dedicated-machine' } : {} }), stderr: '' };
            },
        } satisfies NativeSshModule;
        await expect(runNativeRemoteSshBootstrapTask({ taskId, nativeModule, spec,
            events: { event: event => { events.push(event); } },
            prompt: async question => {
                phases.push('prompt');
                expect(question).toMatchObject({ kind: 'administrator.establish', data: { administratorUsername: 'operator' } });
                return { password };
            },
        })).resolves.toMatchObject({ machineId: 'native-dedicated-machine' });
        expect(phases).toEqual(adminAccessAtCreation === 'ask' ? ['check', 'prompt', 'apply'] : ['check', 'apply']);
        expect(applied.has('docker-membership')).toBe(true);
        expect(administratorEstablished).toBe(adminAccessAtCreation === 'ask');
        const promotion = commands.find(isNativeSshArchivePromotion);
        expect(promotion).toContain('runuser -u happier');
        expect(promotion).toContain('/opt/happier');
        const inventories = commands.filter(command => command.includes('for version_path in'));
        expect(inventories).toHaveLength(2);
        expect(inventories.every(command => command.includes('/opt/happier/cli/versions'))).toBe(true);
        expect(commands.find(command => command.includes('auth status'))).toContain('runuser -u happier');
        expect(events.filter(event => event && typeof event === 'object' && 'stepId' in event && event.stepId === 'native-dedicated-ready')).toHaveLength(1);
        expect(JSON.stringify([spec, commands, events])).not.toContain(password);
        expect(stdoutListeners.size).toBe(0);
    });

    it('runs the shared bootstrap recipe over native SSH for remotes with an installed Happier CLI', async () => {

        const commands: string[] = [];
        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'android',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(async (request) => {
                commands.push(request.command);
                const installation = readInstallationTextResult(request.command);
                if (installation) return { exitCode: installation.status, stdout: installation.stdout, stderr: installation.stderr };
                if (request.command.includes('auth status')) {
                    return {
                        exitCode: 0,
                        stdout: JSON.stringify({
                            ok: true,
                            data: {
                                authenticated: true,
                                credentialState: 'valid',
                                machineRegistered: true,
                                machineRegistrationState: 'server-confirmed',
                                machineId: 'machine-a',
                            },
                        }),
                        stderr: '',
                    };
                }
                return {
                    exitCode: 0,
                    stdout: JSON.stringify({
                        ok: true,
                        data: {},
                    }),
                    stderr: '',
                };
            }),
            cancelRequest: vi.fn(async () => undefined),
        } satisfies NativeSshModule;

        await expect(runNativeRemoteSshBootstrapTask({
            taskId: 'task-a',
            nativeModule,
            spec: createRemoteBootstrapSpec(),
        })).resolves.toEqual({
            machineId: 'machine-a',
        });
        expect(commands.some((command) => command.includes('server set'))).toBe(true);
        expect(commands.some((command) => command.includes('http://localhost.:3005'))).toBe(false);
        expect(commands.some((command) => command.includes('auth status'))).toBe(true);
    });

    // Remote shell fixtures (tar + /bin/sh) require a POSIX test host.
    it.skipIf(process.platform === 'win32')('promotes the verified Home archive and retains the previous CLI on fresh remotes', async () => {
        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'android',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(async () => ({
                exitCode: 127,
                stdout: '',
                stderr: 'happier: command not found',
            })),
            cancelRequest: vi.fn(async () => undefined),
        } satisfies NativeSshModule;
        const commands: string[] = [];
        const home = await mkdtemp(join(tmpdir(), 'happier-native-retention-'));
        const installRoot = join(home, '.happier', 'cli');
        for (const id of ['0.9.0', '1.0.0', '1.1.0', 'local-stable-1792190545251']) {
            await mkdir(join(installRoot, 'versions', id), { recursive: true });
            await writeFile(join(installRoot, 'versions', id, 'happier'), id);
        }
        await symlink('versions/1.1.0', join(installRoot, 'current'));
        await symlink('versions/1.0.0', join(installRoot, 'previous'));
        const layout = firstPartyRuntime.resolveFirstPartyInstallLayout({ componentId: 'happier-cli', channel: 'stable',
            processEnv: { ...process.env, HAPPIER_FIRST_PARTY_INSTALL_HOME: join(home, '.happier') } });
        await firstPartyRuntime.writeInstalledVersionMarker({ layout, marker: 'current', versionId: '1.1.0' });
        await firstPartyRuntime.writeInstalledVersionMarker({ layout, marker: 'previous', versionId: '1.0.0' });
        const payload = await createCliPayloadFixture();
        const archive = join(home, 'payload.tar.gz');
        await promisify(execFile)('tar', ['-czf', archive, '-C', dirname(payload.payloadRoot), basename(payload.payloadRoot)]);
        const homePayload = createNativeSshHomePayload(HOME_TARGET.applicationUrl, new Uint8Array(await readFile(archive)));
        setRuntimeFetch(homePayload.fetch);
        const commandRunner = {
            runJsonCommand: vi.fn(async ({ command }: { command: string }) => {
                commands.push(command);
                if (command.includes('server set')) {
                    return { ok: true, data: {} };
                }
                if (command.includes('auth status')) {
                    return {
                        ok: true,
                        data: {
                            authenticated: true,
                            credentialState: 'valid',
                            machineRegistered: true,
                            machineRegistrationState: 'server-confirmed',
                            machineId: 'machine-fresh',
                        },
                    };
                }
                return { ok: true, data: {} };
            }),
            runTextCommand: vi.fn(async ({ command, input }: { command: string; input?: string }) => {
                commands.push(command);
                if (command.includes('uname -s')) {
                    return {
                        status: 0,
                        stdout: JSON.stringify({ platform: 'linux', arch: 'x86_64' }),
                        stderr: '',
                    };
                }
                if (isNativeSshArchivePromotion(command)) {
                    expect((await readdir(join(installRoot, 'versions'))).sort()).toEqual(['1.0.0', '1.1.0']);
                }
                const run = promisify(execFile)('/bin/sh', ['-c', command], { env: { ...process.env, HOME: home } });
                run.child.stdin?.end(input);
                const result = await run;
                return { status: 0, ...result };
            }),
        };

        try {
            await expect(runNativeRemoteSshBootstrapTask({
                taskId: 'task-a',
                nativeModule,
                spec: createRemoteBootstrapSpec(),
                commandRunner,
            })).resolves.toEqual({
                machineId: 'machine-fresh',
            });
            expect(commands.some(isNativeSshArchivePromotion)).toBe(true);
            expect((await readdir(join(installRoot, 'versions'))).sort()).toEqual(['1.1.0', homePayload.versionId]);
            expect(await readFile(join(installRoot, 'previous', 'happier'), 'utf8')).toBe('1.1.0');
        } finally { await payload.cleanup(); await rm(home, { recursive: true, force: true }); }
    });

    it('approves local terminal auth after the user accepts remote provisioning', async () => {
        const pairingWindow = { createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000 };

        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'android',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(async () => ({
                exitCode: 0,
                stdout: JSON.stringify({ ok: true, data: {} }),
                stderr: '',
            })),
            cancelRequest: vi.fn(async () => undefined),
        } satisfies NativeSshModule;
        const commandRunner = {
            runJsonCommand: vi.fn(async ({ command }: { command: string }) => {
                if (command.includes('auth status')) {
                    return { ok: false, data: { code: 'not_authenticated' } };
                }
                if (command.includes('auth request')) {
                    return {
                        ok: true,
                        data: {
                            publicKey: 'pubkey-a',
                            homeServerIdentityId: 'srv_home_identity',
                            pairing: {
                                secretB64Url: 'pairing-secret-b64url',
                                createdAtMs: 123,
                                expiresAtMs: 456,
                            },
                            supportsTokenOnly: true,
                            pairingRequirement: 'v3',
                        },
                    };
                }
                if (command.includes('auth wait')) {
                    return { ok: true, data: { machineId: 'machine-paired' } };
                }
                return { ok: true, data: {} };
            }),
            runTextCommand: vi.fn(async (options: { command: string; onStdoutChunk?: (text: string) => void }) =>
                readInstallationTextResult(options.command) ?? completeRemoteEnrollment(options, pairingWindow)),
        };
        const approveLocalAuthRequest = vi.fn(async () => undefined);

        await expect(runNativeRemoteSshBootstrapTask({
            taskId: 'task-a',
            nativeModule,
            spec: createRemoteBootstrapSpec(),
            commandRunner,
            prompt: async () => ({ approved: true }),
            approveLocalAuthRequest,
        })).resolves.toEqual({
            machineId: 'machine-paired',
            publicKey: REMOTE_PUBLIC_KEY,
        });
        expect(approveLocalAuthRequest).toHaveBeenCalledWith({
            publicKey: REMOTE_PUBLIC_KEY,
            homeServerIdentityId: 'srv_home_identity',
            pairing: {
                secretB64Url: PAIRING_SECRET,
                ...pairingWindow,
            },
            supportsTokenOnly: true,
            endpointUrl: 'https://relay.example.test',
        });
    });

    it('installs optional relay runtime through the remote CLI over native SSH exec', async () => {

        const commands: string[] = [];
        const nativeModule = {
            getAvailability: () => ({
                available: true,
                platform: 'android',
                engine: 'russh',
                moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: false,
            } as const),
            exec: vi.fn(async () => ({
                exitCode: 0,
                stdout: JSON.stringify({ ok: true, data: {} }),
                stderr: '',
            })),
            cancelRequest: vi.fn(async () => undefined),
        } satisfies NativeSshModule;
        const commandRunner = {
            runJsonCommand: vi.fn(async ({ command }: { command: string }) => {
                commands.push(command);
                if (command.includes('relay host install')) {
                    return {
                        ok: true,
                        data: {
                            relayUrl: 'http://127.0.0.1:40123',
                            mode: 'user',
                        },
                    };
                }
                if (command.includes('auth status')) {
                    return {
                        ok: true,
                        data: {
                            authenticated: true,
                            credentialState: 'valid',
                            machineRegistered: true,
                            machineRegistrationState: 'server-confirmed',
                            machineId: 'machine-relay',
                        },
                    };
                }
                return { ok: true, data: {} };
            }),
            runTextCommand: vi.fn(async ({ command }: { command: string }) =>
                readInstallationTextResult(command) ?? { status: 0, stdout: '', stderr: '' }),
        };

        await expect(runNativeRemoteSshBootstrapTask({
            taskId: 'task-a',
            nativeModule,
            spec: createRemoteBootstrapSpec({
                params: {
                    ...createRemoteBootstrapSpec().params as Record<string, unknown>,
                    relayRuntime: {
                        enabled: true,
                        mode: 'user',
                    },
                },
            }),
            commandRunner,
        })).resolves.toEqual({
            machineId: 'machine-relay',
            relayRuntime: {
                relayUrl: 'http://127.0.0.1:40123',
                mode: 'user',
            },
        });
        expect(commands.some((command) => command.includes('relay host install'))).toBe(true);
    });

    it('rejects mobile-unsupported SSH agent credentials before native execution', async () => {

        expect(() => readNativeSshTaskCredentials(createRemoteBootstrapSpec({
            params: {
                ...createRemoteBootstrapSpec().params as Record<string, unknown>,
                ssh: {
                    target: 'dev@10.0.0.5',
                    port: 2222,
                    auth: 'agent',
                },
            },
        }))).toThrow('native_ssh_missing_credentials');
    });

    it('posts a pairing-bound data-key v3 response to the exact Home target', async () => {
        const boundary = await prepareApprovalBoundary(HOME_TARGET.applicationUrl);

        try {
            const loaded = await import('./nativeTask');
            const nativeModule = {
                getAvailability: () => ({
                    available: true,
                    platform: 'android',
                    engine: 'russh',
                    moduleVersion: '0.0.0',
                    supportsLoopbackTunnel: true,
                    supportsPersistentHostKeyStorage: false,
                } as const),
                exec: vi.fn(async () => ({
                    exitCode: 0,
                    stdout: JSON.stringify({ ok: true, data: {} }),
                    stderr: '',
                })),
                cancelRequest: vi.fn(async () => undefined),
            } satisfies NativeSshModule;
            const publicKey = REMOTE_PUBLIC_KEY;
            const createdAtMs = Date.now() - 1_000;
            const expiresAtMs = Date.now() + 60_000;
            let remoteHomeServerIdentityId = 'srv_home_identity';
            let enrollmentCompleted = false;
            const commandRunner = {
                runJsonCommand: vi.fn(async ({ command }: { command: string }) => {
                    if (command.includes('auth status')) {
                        if (enrollmentCompleted) {
                            return {
                                ok: true,
                                data: {
                                    authenticated: true,
                                    credentialState: 'valid',
                                    machineRegistrationState: 'server-confirmed',
                                    machineId: 'machine-paired',
                                },
                            };
                        }
                        return { ok: false, data: { code: 'not_authenticated' } };
                    }
                    if (command.includes('auth request')) {
                        return {
                            ok: true,
                            data: {
                                publicKey,
                                pairing: {
                                    secretB64Url: Buffer.alloc(32, 7).toString('base64url'),
                                    createdAtMs,
                                    expiresAtMs,
                                },
                                supportsTokenOnly: true,
                                pairingRequirement: 'v3',
                                homeServerIdentityId: remoteHomeServerIdentityId,
                            },
                        };
                    }
                    if (command.includes('auth wait')) {
                        return { ok: true, data: { machineId: 'machine-paired' } };
                    }
                    return { ok: true, data: {} };
                }),
                runTextCommand: vi.fn(async (options: { command: string; onStdoutChunk?: (text: string) => void }) => {
                    const installation = readInstallationTextResult(options.command);
                    if (installation) return installation;
                    const result = completeRemoteEnrollment(options, {
                        homeServerIdentityId: remoteHomeServerIdentityId,
                        publicKey,
                        createdAtMs,
                        expiresAtMs,
                    });
                    enrollmentCompleted = true;
                    return result;
                }),
            };

            await expect(loaded.runNativeRemoteSshBootstrapTask({
                taskId: 'task-token-only',
                nativeModule,
                spec: createRemoteBootstrapSpec({
                    params: {
                        ...createRemoteBootstrapSpec().params as Record<string, unknown>,
                        homeTarget: { ...HOME_TARGET, profileId: boundary.profile.id },
                    },
                }),
                commandRunner,
                prompt: async () => ({ approved: true }),
            })).resolves.toMatchObject({ machineId: 'machine-paired' });
            expect(boundary.approvals).toEqual([{
                url: 'https://relay.example.test/v1/auth/response', authorization: `Bearer ${boundary.storedCredentials.token}`,
                body: expect.objectContaining({ publicKey, responseKind: 'dataKey', response: expect.any(String) }),
            }]);
            expect(boundary.credentials).toHaveBeenCalledWith(
                'https://relay.example.test',
                { serverId: boundary.profile.id },
            );

            remoteHomeServerIdentityId = 'srv_different_home';
            await expect(loaded.runNativeRemoteSshBootstrapTask({
                taskId: 'task-wrong-home',
                nativeModule,
                spec: createRemoteBootstrapSpec({
                    params: {
                        ...createRemoteBootstrapSpec().params as Record<string, unknown>,
                        homeTarget: { ...HOME_TARGET, profileId: boundary.profile.id },
                    },
                }),
                commandRunner,
                prompt: async () => ({ approved: true }),
            })).rejects.toMatchObject({ code: 'home_identity_mismatch' });
            expect(boundary.approvals).toHaveLength(1);
        } finally {
            boundary.dispose();
        }
    });

    it('acquires and releases the canonical Iroh enrollment transport for an Iroh-only Home target', async () => {
        const irohEndpointId = 'a'.repeat(64);
        const release = vi.fn(async () => undefined);
        const ensureHomeTunnel = vi.fn(async () => ({
            leaseId: 'native-task-iroh-lease',
            runtimeOrigin: 'http://127.0.0.1:45992',
            homeServerIdentityId: 'srv_home_identity',
            homeEndpointId: irohEndpointId,
            carrier: 'iroh' as const,
            observedPath: 'direct' as const,
            startedAtMs: Date.now(),
        }));
        const boundary = await prepareApprovalBoundary('http://localhost:3010', 'http://127.0.0.1:45992');
        const { getIrohHomeTunnelRuntime, disposeIrohHomeTunnelRuntime } = await import('@/sync/runtime/nativeIrohTunnels/runtime');
        await disposeIrohHomeTunnelRuntime();
        getIrohHomeTunnelRuntime({ native: { ensureHomeTunnel, releaseHomeTunnel: release } });

        try {
            const loaded = await import('./nativeTask');
            const nativeModule = {
                getAvailability: () => ({
                    available: true,
                    platform: 'android',
                    engine: 'russh',
                    moduleVersion: '0.0.0',
                    supportsLoopbackTunnel: true,
                    supportsPersistentHostKeyStorage: false,
                } as const),
                exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
                cancelRequest: vi.fn(async () => undefined),
            } satisfies NativeSshModule;
            let enrollmentCompleted = false;
            const commandRunner = {
                runJsonCommand: vi.fn(async ({ command }: { command: string }) => {
                    if (command.includes('auth status')) {
                        return enrollmentCompleted
                            ? {
                                ok: true,
                                data: {
                                    authenticated: true,
                                    credentialState: 'valid',
                                    machineRegistrationState: 'server-confirmed',
                                    machineId: 'machine-paired',
                                },
                            }
                            : { ok: false, data: { code: 'not_authenticated' } };
                    }
                    return { ok: true, data: {} };
                }),
                runTextCommand: vi.fn(async (options: { command: string; onStdoutChunk?: (text: string) => void }) => {
                    const installation = readInstallationTextResult(options.command);
                    if (installation) return installation;
                    const result = completeRemoteEnrollment(options, {
                        createdAtMs: Date.now() - 1_000,
                        expiresAtMs: Date.now() + 60_000,
                    });
                    enrollmentCompleted = true;
                    return result;
                }),
            };
            const irohHomeTarget = {
                ...HOME_TARGET,
                profileId: boundary.profile.id,
                descriptor: {
                    v: 1 as const,
                    homeServerIdentityId: 'srv_home_identity',
                    canonicalServerUrl: 'http://localhost:3010',
                    revision: 2,
                    endpoints: [{ kind: 'iroh' as const, endpointId: irohEndpointId }],
                },
                canonicalAuthUrl: 'http://localhost:3010',
                applicationUrl: 'http://localhost:3010',
                webappUrl: 'http://localhost:3010',
                credentialDestination: {
                    v: 1 as const,
                    homeServerIdentityId: 'srv_home_identity',
                    canonicalServerUrl: 'http://localhost:3010',
                    applicationEndpointUrls: [],
                    irohEndpointIds: [irohEndpointId],
                },
                preferredTransport: 'iroh' as const,
            };

            await expect(loaded.runNativeRemoteSshBootstrapTask({
                taskId: 'task-iroh-only',
                nativeModule,
                spec: createRemoteBootstrapSpec({
                    params: {
                        ...createRemoteBootstrapSpec().params as Record<string, unknown>,
                        homeTarget: irohHomeTarget,
                    },
                }),
                commandRunner,
                prompt: async () => ({ approved: true }),
            })).resolves.toMatchObject({ machineId: 'machine-paired' });

            expect(ensureHomeTunnel).toHaveBeenCalledWith(expect.objectContaining({
                homeServerIdentityId: 'srv_home_identity',
                endpointId: irohEndpointId,
            }));
            expect(boundary.approvals).toEqual([expect.objectContaining({
                url: 'http://127.0.0.1:45992/v1/auth/response', authorization: `Bearer ${boundary.storedCredentials.token}`,
                body: expect.objectContaining({ responseKind: 'dataKey' }),
            })]);
            expect(release).toHaveBeenCalledTimes(1);
        } finally {
            await disposeIrohHomeTunnelRuntime();
            boundary.dispose();
        }
    });

    it('passes encrypted private keys to native SSH so the shared passphrase prompt can unlock them', async () => {

        const credentials = readNativeSshTaskCredentials(createRemoteBootstrapSpec({
            params: {
                ...createRemoteBootstrapSpec().params as Record<string, unknown>,
                ssh: {
                    target: 'dev@10.0.0.5',
                    port: 2222,
                    auth: 'keyfile',
                    identityPrivateKey: [
                        '-----BEGIN ENCRYPTED PRIVATE KEY-----',
                        'private-key-body',
                        '-----END ENCRYPTED PRIVATE KEY-----',
                    ].join('\n'),
                },
            },
        }));

        expect(credentials.auth.privateKeyPem).toContain('BEGIN ENCRYPTED PRIVATE KEY');
    });
});
