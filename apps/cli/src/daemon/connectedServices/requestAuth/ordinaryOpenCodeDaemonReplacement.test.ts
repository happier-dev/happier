import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
    SPAWN_SESSION_ERROR_CODES,
    type QualifiedConnectedAccountPurposeBindingV1,
    type QualifiedConnectedAccountRequestAuthUseV1,
} from '@happier-dev/protocol';
import {
    materializeOpenCodeAuthEnvironment,
} from '@happier-dev/plugins-opencode/agent/auth/services/materialize';

import { createDaemonControlApp } from '../../controlServer';
import {
    createConnectedAccountRequestAuthService,
    type ConnectedAccountRequestAuthSubject,
} from './ConnectedAccountRequestAuthService';
import {
    createConnectedAccountRequestAuthSubjectRegistry,
} from './ConnectedAccountRequestAuthSubjectRegistry';

const purpose = {
    consumer: {
        pluginId: 'happier.agent.opencode',
        localId: 'opencode',
    },
    purpose: 'openai-codex-model-request',
} as const;
const account = {
    service: {
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
    },
    accountId: 'ordinary-opencode-account',
} as const;
const binding: QualifiedConnectedAccountPurposeBindingV1 = {
    purpose,
    target: {
        kind: 'account',
        account,
    },
};
const requestAuthUse: QualifiedConnectedAccountRequestAuthUseV1 = {
    purpose,
    materialization: {
        kind: 'httpHeaders',
        origin: 'https://chatgpt.com',
        headerNames: ['authorization', 'chatgpt-account-id'],
    },
};
const materializationId = 'ordinary-opencode-session';

type LoadedOpenCodePlugin = Readonly<{
    default: () => Promise<Readonly<{
        auth: Readonly<{
            loader: (
                getAuth: () => Promise<Readonly<{ type: 'api'; key: string }>>,
            ) => Promise<Readonly<{
                fetch?: typeof fetch;
            }>>;
        }>;
    }>>;
}>;

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => (
        rm(root, { recursive: true, force: true })
    )));
});

function buildSubject(isCurrent: () => boolean): ConnectedAccountRequestAuthSubject {
    return {
        subjectId: 'session:ordinary-opencode/run:surviving',
        isCurrent,
        registerRedaction: () => undefined,
        resolvePurposeUse: (requestedPurpose) => (
            JSON.stringify(requestedPurpose) === JSON.stringify(purpose)
                ? { binding, use: requestAuthUse }
                : null
        ),
        listPurposeUses: () => [{ binding, use: requestAuthUse }],
    };
}

async function readCapability(path: string): Promise<string> {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (
        !parsed
        || typeof parsed !== 'object'
        || !('capability' in parsed)
        || typeof parsed.capability !== 'string'
    ) {
        throw new Error('Expected a request-auth capability document');
    }
    return parsed.capability;
}

async function startDaemon(input: Readonly<{
    materializedRootDir: string;
    accessToken: string;
    credentialRevision: string;
    controlToken: string;
}>) {
    const prepared = await prepareDaemon(input);
    const descriptor = await prepared.registry.activate({
        subject: prepared.subject,
        materializedRootDir: input.materializedRootDir,
        materializationId,
        httpPort: prepared.httpPort,
    });
    return {
        ...prepared,
        descriptor,
    };
}

async function prepareDaemon(input: Readonly<{
    materializedRootDir: string;
    accessToken: string;
    credentialRevision: string;
    controlToken: string;
}>) {
    let current = true;
    const subject = buildSubject(() => current);
    const registry = createConnectedAccountRequestAuthSubjectRegistry();
    const authenticatedCapabilities: unknown[] = [];
    let materializationCount = 0;
    const service = createConnectedAccountRequestAuthService({
        resolveCurrentBinding: () => ({
            account,
            credentialRevision: input.credentialRevision,
        }),
        materializeBearer: async () => {
            materializationCount += 1;
            return {
                accessToken: input.accessToken,
                requiredHeaders: {
                    'chatgpt-account-id': account.accountId,
                },
            };
        },
        refreshAfterAuthFailure: async () => ({ status: 'current_changed' }),
        reportQuotaFailure: async () => ({ status: 'current_changed' }),
    });
    const app = createDaemonControlApp({
        getChildren: () => [],
        machineId: 'machine',
        stopSession: async () => ({ status: 'not_found' as const }),
        spawnSession: async () => ({
            type: 'error' as const,
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: 'unused',
        }),
        requestShutdown: () => undefined,
        onHappySessionWebhook: () => undefined,
        controlToken: input.controlToken,
        connectedAccountRequestAuth: {
            authenticate: (capability) => {
                authenticatedCapabilities.push(capability);
                return registry.authenticate(capability);
            },
            lookupRequestAuth: service.lookupRequestAuth,
            refreshAfterAuthFailure: service.refreshAfterAuthFailure,
            reportQuotaFailure: service.reportQuotaFailure,
        },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
        await app.close();
        throw new Error('Expected daemon request-auth test server TCP address');
    }
    return {
        app,
        registry,
        subject,
        authenticatedCapabilities,
        httpPort: address.port,
        getMaterializationCount: () => materializationCount,
        markReplaced: () => {
            current = false;
        },
    };
}

describe('ordinary OpenCode request-auth across daemon replacement', () => {
    it('fails a staged capability as typed unavailable without replay, then succeeds on a later explicit call after commit', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-staged-'));
        roots.push(root);
        await writeFile(join(root, 'package.json'), '{"type":"module"}\n', 'utf8');
        const originalFetch = globalThis.fetch;
        const restoredEnv = new Map<string, string | undefined>();
        const prepared = await prepareDaemon({
            materializedRootDir: root,
            accessToken: 'access-token-after-commit',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            controlToken: 'control-token-staged',
        });
        const stagedState: {
            descriptor:
                Awaited<ReturnType<typeof prepared.registry.activate>>
                | null;
        } = { descriptor: null };
        let signalStaged!: () => void;
        let releaseFinalProof!: () => void;
        const staged = new Promise<void>((resolve) => {
            signalStaged = resolve;
        });
        const finalProof = new Promise<void>((resolve) => {
            releaseFinalProof = resolve;
        });
        const activation = prepared.registry.activate({
            subject: prepared.subject,
            materializedRootDir: root,
            materializationId,
            httpPort: prepared.httpPort,
            finalizeStagedAuthorityCommit: async (descriptor, commit) => {
                stagedState.descriptor = descriptor;
                signalStaged();
                await finalProof;
                commit();
            },
        });
        let activationSettled = false;
        activation.finally(() => {
            activationSettled = true;
        }).catch(() => undefined);

        try {
            await staged;
            const stagedDescriptor = stagedState.descriptor;
            if (!stagedDescriptor) {
                throw new Error('Expected a staged request-auth capability');
            }
            const stagedCapability = await readCapability(stagedDescriptor.path);
            const materialized = await materializeOpenCodeAuthEnvironment({
                rootDir: root,
                materializationId,
                connectedAccountMaterializationAuthority: 'qualified',
                requestAuth: {
                    capabilityPath: stagedDescriptor.path,
                    purposeBindings: [binding],
                },
            });
            for (const [name, value] of Object.entries(materialized.env)) {
                restoredEnv.set(name, process.env[name]);
                process.env[name] = value;
            }

            const pluginPath = join(
                materialized.env.XDG_CONFIG_HOME ?? '',
                'opencode',
                'plugin',
                'happier-request-auth-openai.js',
            );
            const plugin = await import(
                `${pathToFileURL(pluginPath).href}?loaded-during-staged-authority`
            ) as LoadedOpenCodePlugin;
            const contribution = await plugin.default();
            const loaded = await contribution.auth.loader(async () => ({
                type: 'api',
                key: 'happier-request-auth:openai:1',
            }));
            if (!loaded.fetch) throw new Error('Expected the staged OpenCode request-auth fetch');

            const upstreamAuthorization: string[] = [];
            const upstreamDestinations: string[] = [];
            globalThis.fetch = async (request, init) => {
                const rawUrl = request instanceof Request
                    ? request.url
                    : request instanceof URL
                        ? request.href
                        : String(request);
                const url = new URL(rawUrl);
                if (url.hostname === '127.0.0.1') {
                    return await originalFetch(request, init);
                }
                upstreamDestinations.push(url.href);
                upstreamAuthorization.push(new Headers(init?.headers).get('authorization') ?? '');
                return new Response('ok', { status: 200 });
            };

            await expect(loaded.fetch('https://chatgpt.com/backend-api/responses', {
                method: 'POST',
                body: JSON.stringify({ model: 'gpt-5', input: [] }),
            })).rejects.toMatchObject({
                code: 'request_auth_unavailable',
                status: 503,
            });
            expect(prepared.authenticatedCapabilities).toEqual([stagedCapability]);
            expect(prepared.getMaterializationCount()).toBe(0);
            expect(upstreamAuthorization).toEqual([]);
            expect(upstreamDestinations).toEqual([]);
            expect(activationSettled).toBe(false);

            releaseFinalProof();
            const committedDescriptor = await activation;
            expect(committedDescriptor).toEqual(stagedDescriptor);

            const response = await loaded.fetch('https://chatgpt.com/backend-api/responses', {
                method: 'POST',
                body: JSON.stringify({ model: 'gpt-5', input: [] }),
            });
            expect(response.status).toBe(200);
            expect(prepared.authenticatedCapabilities).toEqual([
                stagedCapability,
                stagedCapability,
            ]);
            expect(prepared.getMaterializationCount()).toBe(1);
            expect(upstreamAuthorization).toEqual([
                'Bearer access-token-after-commit',
            ]);
            // The leaf pins the credential-bearing fetch to the declared origin and rewrites
            // the Codex path; a request to any other destination is refused before the lease.
            expect(upstreamDestinations).toEqual([
                'https://chatgpt.com/backend-api/codex/responses',
            ]);
        } finally {
            releaseFinalProof();
            await activation.catch(() => undefined);
            globalThis.fetch = originalFetch;
            for (const [name, value] of restoredEnv) {
                if (value === undefined) {
                    delete process.env[name];
                } else {
                    process.env[name] = value;
                }
            }
            if (stagedState.descriptor) {
                await prepared.registry.retire(stagedState.descriptor).catch(() => undefined);
            }
            await prepared.app.close().catch(() => undefined);
        }
    });

    it('keeps one loaded leaf authorized by rereading daemon endpoint and rotated capability', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-opencode-daemon-replacement-'));
        roots.push(root);
        await writeFile(join(root, 'package.json'), '{"type":"module"}\n', 'utf8');
        const originalFetch = globalThis.fetch;
        const restoredEnv = new Map<string, string | undefined>();
        let daemonA: Awaited<ReturnType<typeof startDaemon>> | null = null;
        let daemonB: Awaited<ReturnType<typeof startDaemon>> | null = null;
        let daemonAClosed = false;

        try {
            daemonA = await startDaemon({
                materializedRootDir: root,
                accessToken: 'access-token-a',
                credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
                controlToken: 'control-token-a',
            });
            const capabilityA = await readCapability(daemonA.descriptor.path);
            const materialized = await materializeOpenCodeAuthEnvironment({
                rootDir: root,
                materializationId: 'ordinary-daemon-replacement',
                connectedAccountMaterializationAuthority: 'qualified',
                requestAuth: {
                    capabilityPath: daemonA.descriptor.path,
                    purposeBindings: [binding],
                },
            });
            for (const [name, value] of Object.entries(materialized.env)) {
                restoredEnv.set(name, process.env[name]);
                process.env[name] = value;
            }

            const pluginPath = join(
                materialized.env.XDG_CONFIG_HOME ?? '',
                'opencode',
                'plugin',
                'happier-request-auth-openai.js',
            );
            const plugin = await import(
                `${pathToFileURL(pluginPath).href}?loaded-before-daemon-replacement`
            ) as LoadedOpenCodePlugin;
            const contribution = await plugin.default();
            const loaded = await contribution.auth.loader(async () => ({
                type: 'api',
                key: 'happier-request-auth:openai:1',
            }));
            if (!loaded.fetch) throw new Error('Expected the ordinary OpenCode request-auth fetch');
            const survivingFetch = loaded.fetch;
            const upstreamAuthorization: string[] = [];
            const upstreamDestinations: string[] = [];
            globalThis.fetch = async (request, init) => {
                const rawUrl = request instanceof Request
                    ? request.url
                    : request instanceof URL
                        ? request.href
                        : String(request);
                const url = new URL(rawUrl);
                if (url.hostname === '127.0.0.1') {
                    return await originalFetch(request, init);
                }
                upstreamDestinations.push(url.href);
                upstreamAuthorization.push(new Headers(init?.headers).get('authorization') ?? '');
                return new Response('ok', { status: 200 });
            };

            const first = await survivingFetch('https://chatgpt.com/backend-api/responses', {
                method: 'POST',
                body: JSON.stringify({ model: 'gpt-5', input: [] }),
            });
            expect(first.status).toBe(200);

            await daemonA.app.close();
            daemonAClosed = true;
            daemonA.markReplaced();
            daemonB = await startDaemon({
                materializedRootDir: root,
                accessToken: 'access-token-b',
                credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
                controlToken: 'control-token-b',
            });
            const capabilityB = await readCapability(daemonB.descriptor.path);
            const second = await survivingFetch('https://chatgpt.com/backend-api/responses', {
                method: 'POST',
                body: JSON.stringify({ model: 'gpt-5', input: [] }),
            });

            expect(second.status).toBe(200);
            expect(upstreamAuthorization).toEqual([
                'Bearer access-token-a',
                'Bearer access-token-b',
            ]);
            expect(upstreamDestinations).toEqual([
                'https://chatgpt.com/backend-api/codex/responses',
                'https://chatgpt.com/backend-api/codex/responses',
            ]);
            expect(daemonA.authenticatedCapabilities).toEqual([capabilityA]);
            expect(daemonB.authenticatedCapabilities).toEqual([capabilityB]);
            expect(capabilityB).not.toBe(capabilityA);
            expect(daemonB.registry.authenticate(capabilityA)).toBeNull();
            expect(daemonB.authenticatedCapabilities).not.toContain('control-token-a');
            expect(daemonB.authenticatedCapabilities).not.toContain('control-token-b');
        } finally {
            globalThis.fetch = originalFetch;
            for (const [name, value] of restoredEnv) {
                if (value === undefined) {
                    delete process.env[name];
                } else {
                    process.env[name] = value;
                }
            }
            if (daemonB) {
                await daemonB.registry.retire(daemonB.descriptor).catch(() => undefined);
                await daemonB.app.close().catch(() => undefined);
            }
            if (daemonA && !daemonAClosed) {
                await daemonA.app.close().catch(() => undefined);
            }
        }
    });
});
