import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import {
    PLUGIN_MANIFEST as OPENCODE_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-opencode/manifest';

import {
    AGENT_RUNTIME_DAEMON_SERVICES_PATH,
    AgentRuntimeDaemonServiceRequestV1Schema,
    AgentRuntimeDaemonServiceResponseV1Schema,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import {
    createAgentRuntimeDaemonServiceAuthorityPath,
    publishAgentRuntimeDaemonServiceAuthority,
} from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import {
    createAgentSessionRunnerFactoryBinding,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import {
    createDaemonPluginSecretCustodyRouter,
} from '@/plugins/runtime/context/secrets';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { verifyRunnerAgentBindingAgainstGeneration } from '@/plugins/runtime/runner/loadRetainedAgentRuntimeLeaf';
import {
    createImmutablePluginGenerationRecordFromSource,
    persistValidatedAgentSessionRunnerFactories,
    prepareImmutablePluginGeneration,
} from '@/plugins/store/registry/generationStore';

import { createRunnerManagedServiceInvocationOwner } from './createRunnerManagedServiceInvocationOwner';
import { authorizeResolvedAgentNativeExecLaunchForHost } from './exec';
import {
    createManagedServiceEndpointProjectionV1,
} from './managedServiceEndpointProjection';
import {
    resolveRunnerManagedServiceDeclaredSecret,
} from './runnerManagedServiceDeclaredSecretAuthority';
import type { PluginInvocationServicesSeed } from './types';

const EXTERNAL_OPENCODE_PLUGIN_MANIFEST = {
    ...OPENCODE_PLUGIN_MANIFEST,
    id: 'acme.opencode-declared-secret',
};

const SECRET_ID = 'opencodeServerPassword';
const SESSION_ID = 'session-declared-secret';
const RUNNER = Object.freeze({
    pid: 4_242,
    processStartTimeMs: 1_717_171_717_000,
    processCommandHash: 'c'.repeat(64),
    snapshotIdentity: 'snapshot:runner-declared-secret',
});

const connectedAccounts = Object.freeze({}) as ConnectedAccountsService;

type Cleanup = () => Promise<void>;
const cleanups: Cleanup[] = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        await cleanups.pop()?.().catch(() => undefined);
    }
});

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    cleanups.push(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw.trim() ? JSON.parse(raw) as unknown : null;
}

/**
 * The exact production daemon-side owner behind a real HTTP daemon-service
 * endpoint. Only the capability check and transport are re-created here; the
 * declaration lookup, custody and revision all run their real code.
 */
function createStubDaemon(input: Readonly<{
    paths: ReturnType<typeof resolvePluginStorePaths>;
    binding: Parameters<
        typeof createRunnerManagedServiceInvocationOwner
    >[0]['retainedAgent'];
    capability: string;
}>) {
    const secretRequests: string[] = [];
    /**
     * Lets one case answer the pre-dispatch revalidation differently from the
     * live custody state, which is the only way to observe whether the runner
     * actually obeys this daemon's currentness answer.
     */
    const revalidateAnswer: {
        status: 'current' | 'stale' | 'unavailable' | null;
    } = { status: null };
    const server = createServer((request, response) => {
        void (async () => {
            if (request.url !== AGENT_RUNTIME_DAEMON_SERVICES_PATH) {
                response.writeHead(404).end();
                return;
            }
            if (
                request.headers['x-happier-daemon-token']
                !== input.capability
            ) {
                response.writeHead(401).end();
                return;
            }
            const parsed = AgentRuntimeDaemonServiceRequestV1Schema
                .safeParse(await readJsonBody(request));
            if (!parsed.success) {
                response.writeHead(400).end();
                return;
            }
            const operation = parsed.data.operation;
            const result = await (async () => {
                if (operation.kind === 'managed_server.endpoint.publish') {
                    return {
                        kind: 'managed_server.endpoint',
                        status: 'published',
                        projectionToken:
                            createManagedServiceEndpointProjectionV1(
                                operation.projection,
                            ).projectionToken,
                    };
                }
                if (operation.kind === 'managed_server.endpoint.release') {
                    return {
                        kind: 'managed_server.endpoint',
                        status: 'released',
                        released: true,
                    };
                }
                if (operation.kind !== 'managed_server.secret.read') {
                    return null;
                }
                secretRequests.push(operation.phase);
                if (
                    operation.phase === 'revalidate'
                    && revalidateAnswer.status !== null
                ) {
                    return {
                        kind: 'managed_server.secret',
                        requestId: operation.requestId,
                        status: revalidateAnswer.status,
                    };
                }
                return {
                    kind: 'managed_server.secret',
                    requestId: operation.requestId,
                    ...await resolveRunnerManagedServiceDeclaredSecret({
                        paths: input.paths,
                        attested: await verifyRunnerAgentBindingAgainstGeneration({ paths: input.paths, binding: input.binding }),
                        request: {
                            phase: operation.phase,
                            secretId: operation.secretId,
                            canonicalOrigin: operation.canonicalOrigin,
                            ...(operation.expectedRevision
                                ? {
                                    expectedRevision:
                                        operation.expectedRevision,
                                }
                                : {}),
                        },
                    }),
                };
            })();
            if (!result) {
                response.writeHead(501).end();
                return;
            }
            const body = AgentRuntimeDaemonServiceResponseV1Schema.parse({
                ok: true,
                result,
            });
            response
                .writeHead(200, { 'content-type': 'application/json' })
                .end(JSON.stringify(body));
        })().catch(() => {
            response.writeHead(500).end();
        });
    });
    return { server, secretRequests, revalidateAnswer };
}

function createAttachedService() {
    const requests: Readonly<{
        url: string;
        authorization: string | null;
    }>[] = [];
    const server = createServer((request, response) => {
        requests.push(Object.freeze({
            url: request.url ?? '',
            authorization: request.headers.authorization ?? null,
        }));
        response
            .writeHead(200, { 'content-type': 'application/json' })
            .end('[]');
    });
    return { server, requests };
}

async function prepareRetainedAgentFixture(withSecretDeclarations = true) {
    const happyHomeDir = await mkdtemp(join(
        tmpdir(),
        'happier-declared-secret-home-',
    ));
    const sourceRootPath = await mkdtemp(join(
        tmpdir(),
        'happier-declared-secret-source-',
    ));
    cleanups.push(async () => {
        await rm(happyHomeDir, { recursive: true, force: true });
        await rm(sourceRootPath, { recursive: true, force: true });
    });
    const paths = resolvePluginStorePaths({ happyHomeDir });
    await mkdir(join(sourceRootPath, '.happier-plugin'), { recursive: true });
    await mkdir(join(sourceRootPath, 'agent'), { recursive: true });
    await writeFile(
        join(sourceRootPath, '.happier-plugin', 'plugin.json'),
        JSON.stringify(withSecretDeclarations ? EXTERNAL_OPENCODE_PLUGIN_MANIFEST : {
            ...EXTERNAL_OPENCODE_PLUGIN_MANIFEST,
            secrets: [],
            contributes: {
                ...EXTERNAL_OPENCODE_PLUGIN_MANIFEST.contributes,
                settings: (EXTERNAL_OPENCODE_PLUGIN_MANIFEST.contributes.settings ?? []).map(settings => ({
                    ...settings, fields: settings.fields.map(field => ({ ...field, secret: undefined })),
                })),
            },
        }),
        'utf8',
    );
    await writeFile(
        join(sourceRootPath, 'agent', 'runtime.mjs'),
        'export function createRuntime() { throw new Error("unused"); }',
        'utf8',
    );
    const immutableGenerationId = `declared-secret-${createHash('sha256')
        .update(sourceRootPath)
        .digest('hex')
        .slice(0, 16)}`;
    const record = await createImmutablePluginGenerationRecordFromSource({
        pluginId: EXTERNAL_OPENCODE_PLUGIN_MANIFEST.id,
        sourceRootPath,
        manifestRelativePath: '.happier-plugin/plugin.json',
        distribution: { kind: 'localPath', canonicalPath: sourceRootPath },
        updatePolicy: 'allowed',
        createdAtMs: 1,
        immutableGenerationId,
    });
    await prepareImmutablePluginGeneration({ paths, sourceRootPath, record });
    const locator = {
        module: './agent/runtime',
        export: 'createRuntime',
        runtimeApiVersion: 1 as const,
    };
    await persistValidatedAgentSessionRunnerFactories({
        paths,
        record,
        manifestAuthority: 'external',
        factories: [{
            localAgentId: 'opencode',
            locator,
            normalizedModulePath: 'agent/runtime.mjs',
            loadMode: 'immutable-js',
        }],
    });
    const retainedAgent = createAgentSessionRunnerFactoryBinding({
        v: 1,
        pluginId: EXTERNAL_OPENCODE_PLUGIN_MANIFEST.id,
        pluginVersion: EXTERNAL_OPENCODE_PLUGIN_MANIFEST.version,
        agentId: 'opencode',
        localAgentId: 'opencode',
        sourceCustody: {
            kind: 'managed',
            immutableGenerationId,
            installSource: 'localPath',
        },
        locator,
        normalizedModulePath: 'agent/runtime.mjs',
        loadMode: 'immutable-js',
    });
    return { happyHomeDir, paths, retainedAgent };
}

function daemonSecretCustody(
    fixture: Awaited<ReturnType<typeof prepareRetainedAgentFixture>>,
) {
    const custody = createDaemonPluginSecretCustodyRouter({
        paths: fixture.paths,
        resolveDeviceLocalSecretStorage: async () =>
            await readOrCreateDeviceLocalSecretStorage({
                path: join(
                    fixture.happyHomeDir,
                    'device-local-secret-key.json',
                ),
            }),
    }).resolve({
        pluginId: EXTERNAL_OPENCODE_PLUGIN_MANIFEST.id,
        declaration: {
            id: SECRET_ID,
            custody: 'daemon',
            managedServiceOrigin: {
                endpointSettingId: 'opencodeServerBaseUrl',
            },
        },
    });
    if (!custody) throw new Error('Expected daemon secret custody');
    return custody;
}

function invocationSeed(
    fixture: Awaited<ReturnType<typeof prepareRetainedAgentFixture>>,
): PluginInvocationServicesSeed {
    if (fixture.retainedAgent.sourceCustody.kind !== 'managed') {
        throw new Error('Expected managed retained Agent fixture');
    }
    return Object.freeze({
        plugin: {
            id: EXTERNAL_OPENCODE_PLUGIN_MANIFEST.id,
            version: EXTERNAL_OPENCODE_PLUGIN_MANIFEST.version,
        },
        contribution: {
            id: 'opencode',
            qualifiedId: `${EXTERNAL_OPENCODE_PLUGIN_MANIFEST.id}/agents/opencode`,
        },
        occurrenceId: createPluginRuntimeOccurrenceId(
            EXTERNAL_OPENCODE_PLUGIN_MANIFEST.id,
        ),
        sourceCustody: fixture.retainedAgent.sourceCustody,
        correlationId: 'declared-secret-correlation',
        surface: 'agent',
        session: { id: SESSION_ID },
        signal: new AbortController().signal,
        isOccurrenceCurrent: () => true,
    });
}

function basic(password: string): string {
    return `Basic ${Buffer.from(
        `opencode:${password}`,
        'utf8',
    ).toString('base64')}`;
}

function bindAttachedManagedServices(
    owner: Awaited<ReturnType<typeof createRunnerManagedServiceInvocationOwner>>,
    fixture: Awaited<ReturnType<typeof prepareRetainedAgentFixture>>,
) {
    const seed = invocationSeed(fixture);
    const local = owner.owners.createOperationServices(seed, {
        filesystemRoots: {
            pluginData: join(fixture.happyHomeDir, 'plugin-data'),
            workspace: fixture.happyHomeDir,
            projects: new Map(),
        },
        hostAccessRequests: owner.hostAccessRequests,
    });
    return owner.bindManagedServices({
        seed,
        agent: {
            exec: local.exec,
            connectedAccounts,
            // Attach needs no native launch. Keep the canonical finalizer so
            // this declaration-only fixture cannot authorize one accidentally.
            authorizePreparedLaunch: (launch, signal) =>
                authorizeResolvedAgentNativeExecLaunchForHost(
                    local.exec, launch, signal, undefined, 'managedService',
                ),
        },
        managedProvider: null,
    });
}

describe('runner managed-service declared-secret authority', () => {
    it('resolves the credential only from the current daemon and never locally', async () => {
        const fixture = await prepareRetainedAgentFixture();
        const attached = createAttachedService();
        const attachPort = await listen(attached.server);
        const attachBaseUrl = `http://127.0.0.1:${attachPort}`;
        const custody = daemonSecretCustody(fixture);
        await custody.set({
            secretId: SECRET_ID,
            value: 'hunter2',
            canonicalOrigin: attachBaseUrl,
        });

        const capabilityA = 'A'.repeat(43);
        const daemonA = createStubDaemon({
            paths: fixture.paths,
            binding: fixture.retainedAgent,
            capability: capabilityA,
        });
        const daemonAPort = await listen(daemonA.server);
        const authorityPath =
            await createAgentRuntimeDaemonServiceAuthorityPath({
                happyHomeDir: fixture.happyHomeDir,
                publicReleaseRing: 'stable',
            });
        const publishAuthority = async (
            capability: string,
            httpPort: number,
        ) => {
            await publishAgentRuntimeDaemonServiceAuthority({
                happyHomeDir: fixture.happyHomeDir,
                publicReleaseRing: 'stable',
                path: authorityPath,
                sessionId: SESSION_ID,
                runner: RUNNER,
                retainedAgent: fixture.retainedAgent,
                httpPort,
                capability,
                readPluginHardRevocationRevision: async () => 0,
            });
        };
        await publishAuthority(capabilityA, daemonAPort);

        const owner = await createRunnerManagedServiceInvocationOwner({
            paths: fixture.paths,
            authority: {
                happyHomeDir: fixture.happyHomeDir,
                publicReleaseRing: 'stable',
                path: authorityPath,
                sessionId: SESSION_ID,
                runner: RUNNER,
                retainedAgent: fixture.retainedAgent,
            },
            retainedAgent: fixture.retainedAgent,
        });
        cleanups.push(async () => {
            await owner.owners.dispose();
        });
        const managedServices = bindAttachedManagedServices(owner, fixture);
        const handle = await managedServices.supervise({
            id: 'opencode-server',
            mode: { kind: 'attach', baseUrl: attachBaseUrl },
            clientAccess: {
                kind: 'declaredSecretBasic',
                username: 'opencode',
                passwordSecretId: SECRET_ID,
            },
        });

        await handle.request({ pathAndQuery: '/session?limit=1' });
        expect(attached.requests.at(-1)?.authorization).toBe(basic('hunter2'));
        expect(daemonA.secretRequests).toContain('read');

        // Daemon A→B with the same retained runner and handle. B's live
        // custody state — not the value A already served — decides the next
        // credential-bearing request.
        await custody.set({
            secretId: SECRET_ID,
            value: 'rotated-secret',
            canonicalOrigin: attachBaseUrl,
        });
        const capabilityB = 'B'.repeat(43);
        const daemonB = createStubDaemon({
            paths: fixture.paths,
            binding: fixture.retainedAgent,
            capability: capabilityB,
        });
        const daemonBPort = await listen(daemonB.server);
        await publishAuthority(capabilityB, daemonBPort);
        await closeServer(daemonA.server);
        const daemonASecretRequestsAtRotation = daemonA.secretRequests.length;

        await handle.request({ pathAndQuery: '/session?limit=2' });
        expect(attached.requests.at(-1)?.authorization)
            .toBe(basic('rotated-secret'));
        expect(daemonB.secretRequests).toContain('read');
        expect(daemonA.secretRequests).toHaveLength(
            daemonASecretRequestsAtRotation,
        );

        // Daemon-channel loss: no credential-bearing call reaches the attached
        // service at all, even though the encrypted store on this machine
        // still holds a usable secret.
        await closeServer(daemonB.server);
        const attachedRequestsBeforeLoss = attached.requests.length;
        await expect(handle.request({ pathAndQuery: '/session?limit=3' }))
            .rejects.toMatchObject({
                code: 'plugin_managed_service_unavailable',
            });
        expect(attached.requests).toHaveLength(attachedRequestsBeforeLoss);
        expect(
            (await custody.get(SECRET_ID, {
                canonicalOrigin: attachBaseUrl,
            }))?.value,
        ).toBe('rotated-secret');
    });

    it('obeys the current daemon pre-dispatch revalidation before every credential-bearing request', async () => {
        const fixture = await prepareRetainedAgentFixture();
        const attached = createAttachedService();
        const attachPort = await listen(attached.server);
        const attachBaseUrl = `http://127.0.0.1:${attachPort}`;
        const custody = daemonSecretCustody(fixture);
        await custody.set({
            secretId: SECRET_ID,
            value: 'hunter2',
            canonicalOrigin: attachBaseUrl,
        });

        const capability = 'C'.repeat(43);
        const daemon = createStubDaemon({
            paths: fixture.paths,
            binding: fixture.retainedAgent,
            capability,
        });
        const daemonPort = await listen(daemon.server);
        const authorityPath =
            await createAgentRuntimeDaemonServiceAuthorityPath({
                happyHomeDir: fixture.happyHomeDir,
                publicReleaseRing: 'stable',
            });
        await publishAgentRuntimeDaemonServiceAuthority({
            happyHomeDir: fixture.happyHomeDir,
            publicReleaseRing: 'stable',
            path: authorityPath,
            sessionId: SESSION_ID,
            runner: RUNNER,
            retainedAgent: fixture.retainedAgent,
            httpPort: daemonPort,
            capability,
            readPluginHardRevocationRevision: async () => 0,
        });

        const owner = await createRunnerManagedServiceInvocationOwner({
            paths: fixture.paths,
            authority: {
                happyHomeDir: fixture.happyHomeDir,
                publicReleaseRing: 'stable',
                path: authorityPath,
                sessionId: SESSION_ID,
                runner: RUNNER,
                retainedAgent: fixture.retainedAgent,
            },
            retainedAgent: fixture.retainedAgent,
        });
        cleanups.push(async () => {
            await owner.owners.dispose();
        });
        const handle = await bindAttachedManagedServices(owner, fixture).supervise({
            id: 'opencode-server',
            mode: { kind: 'attach', baseUrl: attachBaseUrl },
            clientAccess: {
                kind: 'declaredSecretBasic',
                username: 'opencode',
                passwordSecretId: SECRET_ID,
            },
        });

        // Positive twin: the same reachable daemon answering `current` lets the
        // credential through, so the refusal below cannot be a broken feature.
        daemon.revalidateAnswer.status = 'current';
        await handle.request({ pathAndQuery: '/session?limit=1' });
        expect(attached.requests.at(-1)?.authorization).toBe(basic('hunter2'));
        expect(daemon.secretRequests).toContain('revalidate');

        // The value on this machine is still perfectly usable and the daemon is
        // still reachable; only its currentness answer changed. The runner is
        // not the authority, so no credential-bearing call may leave it.
        daemon.revalidateAnswer.status = 'stale';
        const attachedRequestsBeforeStale = attached.requests.length;
        await expect(handle.request({ pathAndQuery: '/session?limit=2' }))
            .rejects.toMatchObject({
                code: 'plugin_managed_service_unavailable',
            });
        expect(attached.requests).toHaveLength(attachedRequestsBeforeStale);
    });

    it.each([true, false])('reads daemon origin slots with declarations=%s while separating foreign origins and stale revisions', async declared => {
        const fixture = await prepareRetainedAgentFixture(declared);
        const custody = daemonSecretCustody(fixture);
        const origin = 'http://127.0.0.1:4312';
        await custody.set({
            secretId: SECRET_ID,
            value: 'hunter2',
            canonicalOrigin: origin,
        });
        const resolve = async (
            request: Parameters<
                typeof resolveRunnerManagedServiceDeclaredSecret
            >[0]['request'],
        ) => await resolveRunnerManagedServiceDeclaredSecret({
            paths: fixture.paths,
            attested: await verifyRunnerAgentBindingAgainstGeneration({ paths: fixture.paths, binding: fixture.retainedAgent }),
            request,
        });

        const read = await resolve({
            phase: 'read',
            secretId: SECRET_ID,
            canonicalOrigin: origin,
        });
        expect(read).toMatchObject({ status: 'resolved', value: 'hunter2' });
        const revision = read.status === 'resolved' ? read.revision : '';
        await expect(resolve({
            phase: 'revalidate',
            secretId: SECRET_ID,
            canonicalOrigin: origin,
            expectedRevision: revision,
        })).resolves.toEqual({ status: 'current' });

        await expect(resolve({
            phase: 'read',
            secretId: 'notDeclared',
            canonicalOrigin: origin,
        })).resolves.toMatchObject({ status: 'resolved', value: null });
        await expect(resolve({
            phase: 'read',
            secretId: SECRET_ID,
            canonicalOrigin: 'http://127.0.0.1:9999',
        })).resolves.toMatchObject({ status: 'resolved', value: null });

        await custody.set({
            secretId: SECRET_ID,
            value: 'rotated-secret',
            canonicalOrigin: origin,
        });
        await expect(resolve({
            phase: 'revalidate',
            secretId: SECRET_ID,
            canonicalOrigin: origin,
            expectedRevision: revision,
        })).resolves.toEqual({ status: 'stale' });
    });
});
