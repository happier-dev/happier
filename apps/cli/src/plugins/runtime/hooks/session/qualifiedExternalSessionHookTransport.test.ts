import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildWindowsCmdCommand } from '@happier-dev/agents/process/shellCommand';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as runtimeExecutableResolution from '@/packagedRuntime/js/resolveJavaScriptRuntimeExecutable';
import * as atomicJsonWriter from '@/utils/fs/writeJsonAtomic';

import {
    revokeQualifiedExternalSessionHookDurableCredential,
    startQualifiedExternalSessionHookListener,
    type QualifiedExternalSessionHookTransportIngress,
} from './qualifiedExternalSessionHookTransport';
import type {
    QualifiedExternalSessionHookPrincipalInput,
} from './qualifiedExternalSessionHookIngress';

type CreatedPrincipal = Readonly<{
    principalRef: string;
    token: string;
    eventId: string;
    state: 'disabled' | 'enabled' | 'revoked';
}>;

function createIngressHarness() {
    const principals = new Map<string, CreatedPrincipal>();
    const createPrincipal = vi.fn((
        input: QualifiedExternalSessionHookPrincipalInput,
    ) => {
        if (!input.principalRef || !input.token) {
            throw new Error('transport must rehydrate exact credential material');
        }
        principals.set(input.principalRef, {
            principalRef: input.principalRef,
            token: input.token,
            eventId: input.eventId,
            state: 'disabled',
        });
        return {
            principalRef: input.principalRef,
            token: input.token,
        };
    });
    const transition = (
        principalRef: string,
        state: CreatedPrincipal['state'],
    ) => {
        const principal = principals.get(principalRef);
        if (!principal) return { state: 'revoked' as const };
        principals.set(principalRef, { ...principal, state });
        return { state };
    };
    const handleAuthenticatedEvent = vi.fn(async (input: Readonly<{
        token: string;
        eventId: string;
        forwardingStartedAtMs: number;
        observedAtMs: number;
        nativePayload: unknown;
        signal: AbortSignal;
    }>) => {
        const principal = [...principals.values()].find(
            (candidate) => candidate.token === input.token,
        );
        return principal?.state === 'enabled'
            && principal.eventId === input.eventId
            && !input.signal.aborted
            ? { state: 'admitted' as const, facts: 0 }
            : { state: 'rejected' as const };
    });
    const revoke = vi.fn(
        (principalRef: string) => transition(principalRef, 'revoked'),
    );
    const ingress = {
        createPrincipal,
        readPrincipal: (principalRef: string) => ({
            state: principals.get(principalRef)?.state ?? 'revoked' as const,
        }),
        enable: (principalRef: string) => transition(principalRef, 'enabled'),
        disable: (principalRef: string) => transition(principalRef, 'disabled'),
        revoke,
        handleAuthenticatedEvent,
    } satisfies QualifiedExternalSessionHookTransportIngress;
    return { ingress, principals, createPrincipal, handleAuthenticatedEvent };
}

async function runForwarder(input: Readonly<{
    port: number;
    eventId: string;
    secretFile: string;
    payload: unknown;
    extraFlags?: readonly string[];
}>): Promise<Readonly<{
    code: number | null;
    stdout: string;
    stderr: string;
    elapsedMs: number;
}>> {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [
        resolve(process.cwd(), 'scripts', 'session_hook_forwarder.cjs'),
        String(input.port),
        input.eventId,
        '--qualified-external-session',
        '--secret-file',
        input.secretFile,
        ...(input.extraFlags ?? []),
    ], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.stdin.end(JSON.stringify(input.payload));
    return await new Promise((resolveResult, reject) => {
        child.on('error', reject);
        child.on('close', (code) => {
            resolveResult({
                code,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
                elapsedMs: Date.now() - startedAt,
            });
        });
    });
}

async function closeNetServer(server: NetServer): Promise<void> {
    await new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
            if (error) reject(error);
            else resolveClose();
        });
    });
}

async function reserveAvailablePort(): Promise<number> {
    const server = createNetServer();
    await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        await closeNetServer(server);
        throw new Error('test server did not expose a TCP port');
    }
    const port = address.port;
    await closeNetServer(server);
    return port;
}

function closeLeakedTestServer(port: number): void {
    const readActiveHandles = Reflect.get(process, '_getActiveHandles');
    if (typeof readActiveHandles !== 'function') return;
    for (const handle of Reflect.apply(
        readActiveHandles,
        process,
        [],
    ) as unknown[]) {
        if (!handle || typeof handle !== 'object') continue;
        const address = Reflect.get(handle, 'address');
        const close = Reflect.get(handle, 'close');
        if (typeof address !== 'function' || typeof close !== 'function') {
            continue;
        }
        try {
            const value = Reflect.apply(address, handle, []) as unknown;
            if (
                value
                && typeof value === 'object'
                && Reflect.get(value, 'port') === port
            ) {
                Reflect.apply(close, handle, []);
            }
        } catch {
            // Best-effort cleanup for the intentionally reproduced baseline leak.
        }
    }
}

async function expectPortReleased(port: number): Promise<void> {
    let rebound: NetServer | null = null;
    try {
        rebound = createNetServer();
        await new Promise<void>((resolveListen, reject) => {
            rebound!.once('error', reject);
            rebound!.listen(port, '127.0.0.1', () => resolveListen());
        });
    } finally {
        if (rebound?.listening) {
            await closeNetServer(rebound);
        } else {
            closeLeakedTestServer(port);
        }
    }
}

describe('qualified External Session hook transport', () => {
    const listeners: Array<{ stop(): Promise<void> }> = [];
    const roots: string[] = [];

    afterEach(async () => {
        vi.restoreAllMocks();
        await Promise.all(listeners.splice(0).map((listener) => listener.stop()));
        await Promise.all(roots.splice(0).map((root) =>
            rm(root, { recursive: true, force: true })));
    });

    async function createListener() {
        const activeServerDir = join(
            tmpdir(),
            `happier-qualified-hook-${process.pid}-${Date.now()}-${roots.length}`,
        );
        roots.push(activeServerDir);
        const harness = createIngressHarness();
        const listener = await startQualifiedExternalSessionHookListener({
            activeServerDir,
            ingress: harness.ingress,
            nodeExecutable: process.execPath,
            forwarderScript: resolve(
                process.cwd(),
                'scripts',
                'session_hook_forwarder.cjs',
            ),
        });
        listeners.push(listener);
        return { activeServerDir, harness, listener };
    }

    const credentialInput = {
        machineId: 'machine-1',
        agentId: 'fixture-agent',
        qualifiedContributionId: {
            pluginId: 'happier.agent.fixture',
            localId: 'fixture-agent',
        },
        hostInstallationId: 'installation-record-1',
        installationIdentity: 'installation-1',
        variantId: 'variant-1',
        eventId: 'session-stop',
        pluginGeneration: 'generation-1',
        retirementSignal: new AbortController().signal,
    } as const;

    it('closes the bound listener when persisting its endpoint fails', async () => {
        const activeServerDir = join(
            tmpdir(),
            `happier-qualified-hook-endpoint-failure-${process.pid}-${Date.now()}`,
        );
        roots.push(activeServerDir);
        let boundPort: number | null = null;
        vi.spyOn(atomicJsonWriter, 'writeJsonAtomic')
            .mockImplementationOnce(async (_path, value) => {
                boundPort = Number(
                    (value as Readonly<Record<string, unknown>>).port,
                );
                throw new Error('endpoint write failed');
            });

        await expect(startQualifiedExternalSessionHookListener({
            activeServerDir,
            ingress: createIngressHarness().ingress,
            nodeExecutable: process.execPath,
            forwarderScript: '/runtime/session_hook_forwarder.cjs',
        })).rejects.toThrow('endpoint write failed');
        expect(boundPort).not.toBeNull();
        await expectPortReleased(boundPort!);
    });

    it('resolves the managed runtime before binding the persisted listener port', async () => {
        const activeServerDir = join(
            tmpdir(),
            `happier-qualified-hook-runtime-failure-${process.pid}-${Date.now()}`,
        );
        roots.push(activeServerDir);
        const endpointPath = join(
            activeServerDir,
            'external-sessions',
            'hook-ingress',
            'v1',
            'endpoint.json',
        );
        const port = await reserveAvailablePort();
        await mkdir(resolve(endpointPath, '..'), { recursive: true });
        await writeFile(
            endpointPath,
            JSON.stringify({ v: 1, port }),
            'utf8',
        );
        vi.spyOn(
            runtimeExecutableResolution,
            'resolveJavaScriptRuntimeExecutable',
        ).mockReturnValueOnce(null);

        await expect(startQualifiedExternalSessionHookListener({
            activeServerDir,
            ingress: createIngressHarness().ingress,
            forwarderScript: '/runtime/session_hook_forwarder.cjs',
        })).rejects.toBeInstanceOf(ReferenceError);
        await expectPortReleased(port);
    });

    it('rejects an endpoint record one byte over its owner-local ceiling before port selection', async () => {
        const activeServerDir = join(
            tmpdir(),
            `happier-qualified-hook-endpoint-oversize-${process.pid}-${Date.now()}`,
        );
        roots.push(activeServerDir);
        const endpointPath = join(
            activeServerDir,
            'external-sessions',
            'hook-ingress',
            'v1',
            'endpoint.json',
        );
        const poisonedPort = await reserveAvailablePort();
        const blocker = createNetServer();
        await new Promise<void>((resolveListen, reject) => {
            blocker.once('error', reject);
            blocker.listen(poisonedPort, '127.0.0.1', () => resolveListen());
        });
        const emptyRecord = JSON.stringify({
            v: 1,
            port: poisonedPort,
            padding: '',
        });
        const endpointBody = JSON.stringify({
            v: 1,
            port: poisonedPort,
            padding: 'x'.repeat(4_097 - Buffer.byteLength(emptyRecord)),
        });
        expect(Buffer.byteLength(endpointBody)).toBe(4_097);
        await mkdir(resolve(endpointPath, '..'), { recursive: true });
        await writeFile(endpointPath, endpointBody, 'utf8');

        try {
            const listener = await startQualifiedExternalSessionHookListener({
                activeServerDir,
                ingress: createIngressHarness().ingress,
                nodeExecutable: process.execPath,
                forwarderScript: '/runtime/session_hook_forwarder.cjs',
            });
            listeners.push(listener);
            expect(listener.port).not.toBe(poisonedPort);
        } finally {
            await closeNetServer(blocker);
        }
    });

    it.each([
        {
            label: 'one byte over the credential ceiling',
            suffix: '\n\n',
        },
        {
            label: 'non-newline trailing content at the credential ceiling',
            suffix: ' ',
        },
    ])('rejects $label instead of trimming it into a valid token', async ({
        suffix,
    }) => {
        const { listener, harness } = await createListener();
        const credential = await listener.createOrReuseCredential(
            credentialInput,
        );
        const token = (await readFile(credential.secretFile, 'utf8'))
            .replace(/\n$/u, '');
        await writeFile(credential.secretFile, `${token}${suffix}`, 'utf8');
        harness.createPrincipal.mockClear();

        await expect(listener.createOrReuseCredential({
            ...credentialInput,
            installationPrincipalRef: credential.installationPrincipalRef,
        })).rejects.toThrow(
            'Invalid qualified External Session hook credential',
        );
        expect(harness.createPrincipal).not.toHaveBeenCalled();
    });

    it('uses one listener for multiple qualified principals and forwards exact authenticated events', async () => {
        const { listener, harness } = await createListener();
        const first = await listener.createOrReuseCredential(credentialInput);
        const second = await listener.createOrReuseCredential({
            ...credentialInput,
            hostInstallationId: 'installation-record-2',
            installationIdentity: 'installation-2',
            eventId: 'session-start',
        });
        listener.enable(first.eventPrincipalRef);
        listener.enable(second.eventPrincipalRef);
        expect(listener.readCredentialState({
            qualifiedContributionId: credentialInput.qualifiedContributionId,
            hostInstallationId: credentialInput.hostInstallationId,
            installationPrincipalRef: first.installationPrincipalRef,
            eventId: first.eventId,
        })).toEqual({ state: 'enabled' });

        const firstResult = await runForwarder({
            port: listener.port,
            eventId: credentialInput.eventId,
            secretFile: first.secretFile,
            payload: { session_id: 'native-1' },
        });
        const secondResult = await runForwarder({
            port: listener.port,
            eventId: 'session-start',
            secretFile: second.secretFile,
            payload: { session_id: 'native-2' },
        });

        expect(firstResult).toMatchObject({ code: 0, stdout: '', stderr: '' });
        expect(secondResult).toMatchObject({ code: 0, stdout: '', stderr: '' });
        expect(harness.handleAuthenticatedEvent).toHaveBeenCalledTimes(2);
        expect(new Set(
            harness.handleAuthenticatedEvent.mock.calls.map(
                ([delivery]) => delivery.eventId,
            ),
        )).toEqual(new Set(['session-stop', 'session-start']));
        listener.disable(first.eventPrincipalRef);
        expect(listener.readCredentialState({
            qualifiedContributionId: credentialInput.qualifiedContributionId,
            hostInstallationId: credentialInput.hostInstallationId,
            installationPrincipalRef: first.installationPrincipalRef,
            eventId: first.eventId,
        })).toEqual({ state: 'disabled' });
    });

    it('reuses on ordinary restart, rotates on verified replacement, and rejects the predecessor secret', async () => {
        const firstHarness = createIngressHarness();
        const activeServerDir = join(
            tmpdir(),
            `happier-qualified-hook-restart-${process.pid}-${Date.now()}`,
        );
        roots.push(activeServerDir);
        const firstListener = await startQualifiedExternalSessionHookListener({
            activeServerDir,
            ingress: firstHarness.ingress,
            nodeExecutable: process.execPath,
            forwarderScript: '/runtime/session_hook_forwarder.cjs',
        });
        const credential = await firstListener.createOrReuseCredential(
            credentialInput,
        );
        const firstToken = await readFile(credential.secretFile, 'utf8');
        const persistedPort = firstListener.port;
        await firstListener.stop();

        const restartedHarness = createIngressHarness();
        const restarted = await startQualifiedExternalSessionHookListener({
            activeServerDir,
            ingress: restartedHarness.ingress,
            nodeExecutable: process.execPath,
            forwarderScript: '/runtime/session_hook_forwarder.cjs',
        });
        listeners.push(restarted);
        const reused = await restarted.createOrReuseCredential({
            ...credentialInput,
            installationPrincipalRef: credential.installationPrincipalRef,
        });

        expect(restarted.port).toBe(persistedPort);
        expect(reused.secretFile).toBe(credential.secretFile);
        expect(await readFile(reused.secretFile, 'utf8')).toBe(firstToken);
        restarted.disable(reused.eventPrincipalRef);
        expect(await readFile(reused.secretFile, 'utf8')).toBe(firstToken);

        const predecessorSecretFile = join(
            activeServerDir,
            'predecessor-session-stop.secret',
        );
        await writeFile(predecessorSecretFile, firstToken, 'utf8');
        const rotated = await restarted.rotateCredential({
            ...credentialInput,
            installationPrincipalRef: credential.installationPrincipalRef,
        });
        const rotatedToken = await readFile(rotated.secretFile, 'utf8');
        expect(rotatedToken).not.toBe(firstToken);
        restarted.enable(rotated.eventPrincipalRef);

        await runForwarder({
            port: restarted.port,
            eventId: rotated.eventId,
            secretFile: predecessorSecretFile,
            payload: { session_id: 'predecessor-native-session' },
        });
        await runForwarder({
            port: restarted.port,
            eventId: rotated.eventId,
            secretFile: rotated.secretFile,
            payload: { session_id: 'successor-native-session' },
        });
        await expect(
            restartedHarness.handleAuthenticatedEvent.mock.results[0]?.value,
        ).resolves.toEqual({ state: 'rejected' });
        await expect(
            restartedHarness.handleAuthenticatedEvent.mock.results[1]?.value,
        ).resolves.toEqual({ state: 'admitted', facts: 0 });

        await restarted.revokeDurableCredential({
            qualifiedContributionId: credentialInput.qualifiedContributionId,
            hostInstallationId: credentialInput.hostInstallationId,
            installationPrincipalRef: credential.installationPrincipalRef,
            eventId: rotated.eventId,
        });
        await expect(readFile(rotated.secretFile, 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('waits boundedly for the predecessor to release the persisted listener port', async () => {
        const activeServerDir = join(
            tmpdir(),
            `happier-qualified-hook-takeover-${process.pid}-${Date.now()}`,
        );
        roots.push(activeServerDir);
        const predecessor = await startQualifiedExternalSessionHookListener({
            activeServerDir,
            ingress: createIngressHarness().ingress,
            nodeExecutable: process.execPath,
            forwarderScript: '/runtime/session_hook_forwarder.cjs',
        });
        const persistedPort = predecessor.port;

        const successorPromise = startQualifiedExternalSessionHookListener({
            activeServerDir,
            ingress: createIngressHarness().ingress,
            nodeExecutable: process.execPath,
            forwarderScript: '/runtime/session_hook_forwarder.cjs',
        });
        await new Promise<void>((resolveDelay) => {
            setTimeout(resolveDelay, 150);
        });
        await predecessor.stop();

        const successor = await successorPromise;
        listeners.push(successor);
        expect(successor.port).toBe(persistedPort);
    });

    it('revokes exactly one durable credential while the listener is down', async () => {
        const { activeServerDir, listener } = await createListener();
        const first = await listener.createOrReuseCredential(credentialInput);
        const second = await listener.createOrReuseCredential({
            ...credentialInput,
            eventId: 'session-start',
        });
        await listener.stop();

        await revokeQualifiedExternalSessionHookDurableCredential({
            activeServerDir,
            qualifiedContributionId: credentialInput.qualifiedContributionId,
            hostInstallationId: credentialInput.hostInstallationId,
            installationPrincipalRef: first.installationPrincipalRef,
            eventId: first.eventId,
        });

        await expect(readFile(first.secretFile, 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
        await expect(readFile(second.secretFile, 'utf8')).resolves.not.toBe('');
    });

    it('revokes an owned credential after restart when the plugin is unavailable', async () => {
        const activeServerDir = join(
            tmpdir(),
            `happier-qualified-hook-unavailable-${process.pid}-${Date.now()}`,
        );
        roots.push(activeServerDir);
        const firstHarness = createIngressHarness();
        const firstListener = await startQualifiedExternalSessionHookListener({
            activeServerDir,
            ingress: firstHarness.ingress,
            nodeExecutable: process.execPath,
            forwarderScript: '/runtime/session_hook_forwarder.cjs',
        });
        const credential = await firstListener.createOrReuseCredential(
            credentialInput,
        );
        await firstListener.stop();

        const restartedHarness = createIngressHarness();
        const restarted = await startQualifiedExternalSessionHookListener({
            activeServerDir,
            ingress: restartedHarness.ingress,
            nodeExecutable: process.execPath,
            forwarderScript: '/runtime/session_hook_forwarder.cjs',
        });
        listeners.push(restarted);

        expect(restarted.disableDurableCredential({
            qualifiedContributionId: credentialInput.qualifiedContributionId,
            hostInstallationId: credentialInput.hostInstallationId,
            installationPrincipalRef: credential.installationPrincipalRef,
            eventId: credential.eventId,
        })).toEqual({ state: 'revoked' });
        expect(await readFile(credential.secretFile, 'utf8')).not.toBe('');

        await restarted.revokeDurableCredential({
            qualifiedContributionId: credentialInput.qualifiedContributionId,
            hostInstallationId: credentialInput.hostInstallationId,
            installationPrincipalRef: credential.installationPrincipalRef,
            eventId: credential.eventId,
        });
        await restarted.revokeDurableCredential({
            qualifiedContributionId: credentialInput.qualifiedContributionId,
            hostInstallationId: credentialInput.hostInstallationId,
            installationPrincipalRef: credential.installationPrincipalRef,
            eventId: credential.eventId,
        });

        expect(restartedHarness.ingress.revoke).toHaveBeenCalledTimes(2);
        expect(restartedHarness.ingress.revoke).toHaveBeenNthCalledWith(
            1,
            credential.eventPrincipalRef,
        );
        await expect(readFile(credential.secretFile, 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
        expect(restartedHarness.createPrincipal).not.toHaveBeenCalled();
    });

    it.each([
        {
            label: 'valid',
            mutate: async (_secretFile: string) => {},
            expectedState: 'restored',
        },
        {
            label: 'missing',
            mutate: async (secretFile: string) => {
                await rm(secretFile);
            },
            expectedState: 'missing',
        },
        {
            label: 'malformed',
            mutate: async (secretFile: string) => {
                await writeFile(secretFile, '!'.repeat(43), 'utf8');
            },
            expectedState: 'corrupt',
        },
        {
            label: 'oversized',
            mutate: async (secretFile: string) => {
                await writeFile(secretFile, `${'a'.repeat(43)}\n\n`, 'utf8');
            },
            expectedState: 'corrupt',
        },
    ] as const)(
        'restores $label durable credential without repairing its file',
        async ({ mutate, expectedState }) => {
            const activeServerDir = join(
                tmpdir(),
                `happier-qualified-hook-restore-${expectedState}-${process.pid}-${Date.now()}`,
            );
            roots.push(activeServerDir);
            const firstListener =
                await startQualifiedExternalSessionHookListener({
                    activeServerDir,
                    ingress: createIngressHarness().ingress,
                    nodeExecutable: process.execPath,
                    forwarderScript: '/runtime/session_hook_forwarder.cjs',
                });
            const credential = await firstListener.createOrReuseCredential(
                credentialInput,
            );
            await firstListener.stop();
            await mutate(credential.secretFile);
            const expectedFileContents = await readFile(
                credential.secretFile,
                'utf8',
            ).catch(() => null);

            const restartedHarness = createIngressHarness();
            const restarted =
                await startQualifiedExternalSessionHookListener({
                    activeServerDir,
                    ingress: restartedHarness.ingress,
                    nodeExecutable: process.execPath,
                    forwarderScript: '/runtime/session_hook_forwarder.cjs',
                });
            listeners.push(restarted);
            const result = await restarted.restoreCredential({
                ...credentialInput,
                installationPrincipalRef:
                    credential.installationPrincipalRef,
            });

            if (expectedState === 'restored') {
                expect(result).toEqual({ state: 'restored', credential });
                expect(restartedHarness.createPrincipal).toHaveBeenCalledOnce();
            } else {
                expect(result).toEqual({
                    state: 'unavailable',
                    reason: expectedState,
                });
                expect(restartedHarness.createPrincipal).not.toHaveBeenCalled();
            }
            await expect(readFile(credential.secretFile, 'utf8')
                .catch(() => null)).resolves.toBe(expectedFileContents);
        },
    );

    it('builds POSIX and Windows cmd entries from the leaf-declared dialect', async () => {
        const { listener } = await createListener();
        const event = {
            eventId: 'session-stop',
            targetId: 'settings',
            nativeEventName: 'Stop',
            command: {
                kind: 'happier_observation_v1' as const,
                shellDialect: 'posix' as const,
                matcher: 'final',
                timeoutMs: 400,
            },
        };
        const previewEntry = listener.buildOwnedEntryPreview({
            qualifiedContributionId:
                credentialInput.qualifiedContributionId,
            hostInstallationId: credentialInput.hostInstallationId,
            event,
        });
        const credential = await listener.createOrReuseCredential(
            credentialInput,
        );
        expect(previewEntry).toEqual(listener.buildOwnedEntry({
            credential,
            event,
        }));

        expect(listener.buildOwnedEntry({
            credential,
            event,
        })).toEqual({
            matcher: 'final',
            hooks: [{
                type: 'command',
                command: [
                    `'${process.execPath}'`,
                    `'${resolve(
                        process.cwd(),
                        'scripts',
                        'session_hook_forwarder.cjs',
                    )}'`,
                    `'${String(listener.port)}'`,
                    "'session-stop'",
                    "'--qualified-external-session'",
                    "'--secret-file'",
                    `'${credential.secretFile}'`,
                ].join(' '),
                timeout: 1,
            }],
        });

        expect(listener.buildOwnedEntry({
            credential,
            event: {
                ...event,
                command: {
                    ...event.command,
                    shellDialect: 'windows_cmd',
                },
            },
        })).toEqual({
            matcher: 'final',
            hooks: [{
                type: 'command',
                command: buildWindowsCmdCommand([
                    process.execPath,
                    resolve(
                        process.cwd(),
                        'scripts',
                        'session_hook_forwarder.cjs',
                    ),
                    String(listener.port),
                    'session-stop',
                    '--qualified-external-session',
                    '--secret-file',
                    credential.secretFile,
                ]),
                timeout: 1,
            }],
        });
    });

    it('rejects event/token mismatch and keeps dead or hung delivery fail-silent with one 500 ms attempt', async () => {
        const { listener, harness } = await createListener();
        const credential = await listener.createOrReuseCredential(
            credentialInput,
        );
        listener.enable(credential.eventPrincipalRef);

        const mismatched = await runForwarder({
            port: listener.port,
            eventId: 'session-start',
            secretFile: credential.secretFile,
            payload: { raw_secret_marker: 'must-not-be-logged' },
        });
        expect(mismatched).toMatchObject({ code: 0, stdout: '', stderr: '' });
        expect(harness.handleAuthenticatedEvent).toHaveBeenCalledOnce();

        harness.handleAuthenticatedEvent.mockImplementationOnce(
            async () => await new Promise(() => {}),
        );
        const hung = await runForwarder({
            port: listener.port,
            eventId: 'session-stop',
            secretFile: credential.secretFile,
            payload: { session_id: 'hung-native-session' },
        });
        expect(hung).toMatchObject({ code: 0, stdout: '', stderr: '' });
        expect(hung.elapsedMs).toBeLessThan(1_000);
        expect(harness.handleAuthenticatedEvent).toHaveBeenCalledTimes(2);
    });

    it.each([
        {
            label: 'one byte over the credential ceiling',
            contents: `${'a'.repeat(43)}\n\n`,
        },
        {
            label: 'corrupt credential content',
            contents: '!'.repeat(43),
        },
    ])('keeps $label away from the authenticated handler', async ({
        contents,
    }) => {
        const { listener, harness } = await createListener();
        const credential = await listener.createOrReuseCredential(
            credentialInput,
        );
        listener.enable(credential.eventPrincipalRef);
        await writeFile(credential.secretFile, contents, 'utf8');
        harness.handleAuthenticatedEvent.mockClear();

        const result = await runForwarder({
            port: listener.port,
            eventId: credential.eventId,
            secretFile: credential.secretFile,
            payload: { session_id: 'must-not-reach-handler' },
        });

        expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
        expect(harness.handleAuthenticatedEvent).not.toHaveBeenCalled();
    });
});
