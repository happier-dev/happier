import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import type { ExecService } from '@happier-dev/plugin-sdk/exec';

import type {
    ManagedServiceProcessHandle,
    ManagedServiceProcessSupervisor,
    ManagedServiceProcessSupervisorHost,
} from './managedProcessSupervisor';
import { createManagedServiceProcessSupervisorHost } from './managedProcessSupervisor';
import { createDeclaredManagedServiceSecretResolver } from './declaredManagedServiceSecret';
import {
    createManagedServicesOwner,
    type ResolveDeclaredManagedServiceSecret,
} from './managedServicesOwner';

const exec = Object.freeze({}) as ExecService;

/**
 * An attached service is a server the host did not spawn, so a host-minted
 * credential cannot authenticate to it. These cover the one canonical
 * mechanism that can: a user-recorded secret the host resolves and applies —
 * to requests *and* to the health probe, because a password-protected
 * OpenCode server answers `/global/health` with 401 exactly like every other
 * route, so an unauthenticated probe never lets the service become healthy.
 */
function createAttachHarness(input: Readonly<{
    hostFetch?: typeof globalThis.fetch;
    resolveDeclaredSecret?: ResolveDeclaredManagedServiceSecret;
    registerRawForRedaction?: (
        scope: Readonly<{ pluginId: string }>,
        value: string,
    ) => void;
} > = {}) {
    const attachedSnapshot = Object.freeze({
        id: 'opencode-server',
        instanceId: 'instance-one',
        state: 'healthy' as const,
        mode: 'externalAttach' as const,
        baseUrl: 'http://127.0.0.1:4312',
        port: 4312,
        pid: null,
        startedAtMs: 1,
        lastHealthyAtMs: 10,
        diagnostics: Object.freeze([]),
        diagnosticsTruncated: false,
    });
    const legacyHandle = Object.freeze({
        snapshot: () => attachedSnapshot,
        observe: vi.fn(() => Object.freeze({ dispose() {} })),
        waitUntilHealthy: vi.fn(async () => attachedSnapshot),
        stop: vi.fn(async () => Object.freeze({ status: 'detached' as const })),
        dispose: vi.fn(async () => undefined),
    }) satisfies ManagedServiceProcessHandle;
    const supervise = vi.fn<ManagedServiceProcessSupervisor['supervise']>(
        async () => legacyHandle,
    );
    const registerRawForRedaction = vi.fn(
        input.registerRawForRedaction ?? (() => undefined),
    );
    const owner = createManagedServicesOwner({
        processSupervisorHost: Object.freeze({
            custodyOwner: 'daemon',
            bind: vi.fn(() => Object.freeze({ supervise })),
        }) satisfies ManagedServiceProcessSupervisorHost,
        dependencies: Object.freeze({}) as never,
        resolveScope: (scope) => scope,
        ...(input.hostFetch ? { fetch: input.hostFetch } : {}),
        registerRawForRedaction,
        ...(input.resolveDeclaredSecret
            ? { resolveDeclaredSecret: input.resolveDeclaredSecret }
            : {}),
    });
    const scope = {
        generation: 'generation-one',
        pluginId: 'happier.agent.opencode',
        contributionQualifiedId: 'happier.agent.opencode/agents/opencode',
        operationId: 'external-sessions:browse',
        signal: new AbortController().signal,
        isGenerationCurrent: () => true,
    };
    return { owner, scope, supervise, registerRawForRedaction, legacyHandle };
}

function declaredSecretLease(
    value: string | null,
    revision = `fixture-secret-r1:${value ?? 'missing'}`,
): Readonly<{
    value: string | null;
    revision: string;
    isCurrent(signal?: AbortSignal): Promise<boolean>;
}> {
    return Object.freeze({
        value,
        revision,
        async isCurrent(signal?: AbortSignal) {
            return !signal?.aborted;
        },
    });
}

function deferred<T>(): Readonly<{
    promise: Promise<T>;
    resolve(value: T): void;
}> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolver) => {
        resolve = resolver;
    });
    return Object.freeze({ promise, resolve });
}

const ATTACH_SPEC = Object.freeze({
    id: 'opencode-server',
    mode: Object.freeze({
        kind: 'attach' as const,
        baseUrl: 'http://127.0.0.1:4312',
    }),
    healthCheck: Object.freeze({
        kind: 'http' as const,
        target: Object.freeze({
            kind: 'servicePath' as const,
            path: '/global/health',
        }),
        timeoutMs: 5_000,
    }),
    healthPolicy: Object.freeze({
        intervalMs: 10_000,
        consecutiveFailures: 3,
    }),
    startupTimeoutMs: 30_000,
});

describe('managed-service attach client access', () => {
    it('authenticates an attached service and its health probe from the declared user secret', async () => {
        const hostFetch = vi.fn<typeof globalThis.fetch>(async () =>
            new Response('[]', { status: 200 }));
        const resolveDeclaredSecret = vi.fn(async () => declaredSecretLease('hunter2'));
        const harness = createAttachHarness({
            hostFetch,
            resolveDeclaredSecret,
        });
        const services = harness.owner.bindScope(harness.scope, exec);

        const handle = await services.supervise({
            ...ATTACH_SPEC,
            clientAccess: {
                kind: 'declaredSecretBasic',
                username: 'opencode',
                passwordSecretId: 'opencodeServerPassword',
            },
        });

        const expectedAuthorization = `Basic ${Buffer.from(
            'opencode:hunter2',
            'utf8',
        ).toString('base64')}`;
        expect(resolveDeclaredSecret).not.toHaveBeenCalled();
        const ownedSpec = harness.supervise.mock.calls[0]?.[0];
        expect(
            ownedSpec?.mode.kind === 'externalAttach'
                ? ownedSpec.mode.credential?.httpHeader
                : undefined,
        ).toBeUndefined();
        // The whole point: `/global/health` 401s without this header, so the
        // attach service could never reach `healthy` against a secured server.
        const resolveHealthHeaders = ownedSpec?.healthCheck?.kind === 'http'
            ? ownedSpec.healthCheck.resolveHeaders
            : undefined;
        if (!resolveHealthHeaders) {
            throw new Error('expected a current declared-secret health resolver');
        }
        await expect(resolveHealthHeaders()).resolves.toMatchObject({
            headers: { authorization: expectedAuthorization },
        });
        expect(resolveDeclaredSecret).toHaveBeenCalledWith(
            expect.objectContaining({
                secretId: 'opencodeServerPassword',
                canonicalOrigin: 'http://127.0.0.1:4312',
                scope: expect.objectContaining({
                    pluginId: 'happier.agent.opencode',
                }),
            }),
        );
        expect(ownedSpec?.healthCheck?.kind === 'http'
            ? ownedSpec.healthCheck.headers?.authorization
            : undefined).toBeUndefined();

        await handle.request({ pathAndQuery: '/session?limit=50' });
        const sentHeaders = new Headers(
            hostFetch.mock.calls[0]?.[1]?.headers
                ?? ({} as Readonly<Record<string, string>>),
        );
        expect(sentHeaders.get('authorization')).toBe(expectedAuthorization);

        expect(harness.registerRawForRedaction).toHaveBeenCalledWith(
            expect.anything(),
            'hunter2',
        );
        const serialized = JSON.stringify(handle.snapshot());
        expect(serialized).not.toContain('hunter2');
        expect(serialized).not.toContain(expectedAuthorization);
    });

    it('keeps an unconfigured attach unauthenticated while re-resolving its declared secret', async () => {
        let recorded: string | null = null;
        const hostFetch = vi.fn<typeof globalThis.fetch>(async () =>
            new Response('[]', { status: 200 }));
        const harness = createAttachHarness({
            hostFetch,
            resolveDeclaredSecret: async () => declaredSecretLease(recorded),
        });
        const services = harness.owner.bindScope(harness.scope, exec);
        const handle = await services.supervise({
            ...ATTACH_SPEC,
            clientAccess: {
                kind: 'declaredSecretBasic',
                username: 'opencode',
                passwordSecretId: 'opencodeServerPassword',
            },
        });

        const unconfigured = createAttachHarness();
        await unconfigured.owner
            .bindScope(unconfigured.scope, exec)
            .supervise({ ...ATTACH_SPEC, clientAccess: { kind: 'none' } });

        const ownedSpec = harness.supervise.mock.calls[0]?.[0];
        const noneSpec = unconfigured.supervise.mock.calls[0]?.[0];
        expect(ownedSpec?.mode).toEqual(noneSpec?.mode);
        expect(ownedSpec?.healthCheck?.kind === 'http'
            ? ownedSpec.healthCheck.headers
            : undefined).toEqual(noneSpec?.healthCheck?.kind === 'http'
            ? noneSpec.healthCheck.headers
            : undefined);
        const resolveHealthHeaders = ownedSpec?.healthCheck?.kind === 'http'
            ? ownedSpec.healthCheck.resolveHeaders
            : undefined;
        expect(resolveHealthHeaders).toEqual(expect.any(Function));
        if (!resolveHealthHeaders) {
            throw new Error('expected an unconfigured declared-secret health resolver');
        }
        await expect(resolveHealthHeaders()).resolves.toMatchObject({
            headers: {},
        });
        await handle.request({ pathAndQuery: '/session?limit=50' });
        expect(new Headers(hostFetch.mock.calls[0]?.[1]?.headers).get(
            'authorization',
        )).toBeNull();

        recorded = 'configured-later';
        const expectedAuthorization = `Basic ${Buffer.from(
            'opencode:configured-later',
            'utf8',
        ).toString('base64')}`;
        await expect(resolveHealthHeaders()).resolves.toMatchObject({
            headers: { authorization: expectedAuthorization },
        });
        await handle.request({ pathAndQuery: '/session?limit=50' });
        expect(new Headers(hostFetch.mock.calls[1]?.[1]?.headers).get(
            'authorization',
        )).toBe(expectedAuthorization);
        expect(harness.registerRawForRedaction).toHaveBeenCalledWith(
            expect.anything(),
            'configured-later',
        );
    });

    it('rejects a user-secret credential on a host-owned spawn', async () => {
        const harness = createAttachHarness({
            resolveDeclaredSecret: async () => declaredSecretLease('hunter2'),
        });
        const services = harness.owner.bindScope(harness.scope, exec);

        await expect(services.supervise({
            id: 'opencode-server',
            clientAccess: {
                kind: 'declaredSecretBasic',
                passwordSecretId: 'opencodeServerPassword',
            },
            mode: {
                kind: 'spawn',
                launch: { executable: {} as never },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'fixed', port: 4312 },
                },
            },
        } as never)).rejects.toMatchObject({
            code: 'plugin_managed_service_spec_invalid',
        });
        expect(harness.supervise).not.toHaveBeenCalled();
    });

    /**
     * The first-run path this whole mechanism exists to serve is a mistyped
     * password: the user corrects it in Settings and expects the same attach
     * lifecycle to use it on its next health probe. Secret bytes are per-use
     * input, not semantic-entry identity.
     */
    it('reuses the established attach entry across secret rotation and resolves the current value per use', async () => {
        let recorded = 'first-recorded-secret';
        const resolveDeclaredSecret = vi.fn(async () => declaredSecretLease(recorded));
        const harness = createAttachHarness({ resolveDeclaredSecret });
        const services = harness.owner.bindScope(harness.scope, exec);
        const spec = {
            ...ATTACH_SPEC,
            clientAccess: {
                kind: 'declaredSecretBasic' as const,
                username: 'opencode',
                passwordSecretId: 'opencodeServerPassword',
            },
        };
        const healthProbeHeader = async (): Promise<string | undefined> => {
            const supervised = harness.supervise.mock.calls[0]?.[0];
            if (supervised?.healthCheck?.kind !== 'http') return undefined;
            const lease = await supervised.healthCheck.resolveHeaders?.();
            return lease?.headers.authorization;
        };

        const first = await services.supervise(spec);
        expect(resolveDeclaredSecret).not.toHaveBeenCalled();
        const firstHealthProbeHeader = await healthProbeHeader();
        recorded = 'corrected-recorded-secret';
        const [second, concurrent] = await Promise.all([
            services.supervise(spec),
            services.supervise(spec),
        ]);
        const secondHealthProbeHeader = await healthProbeHeader();

        expect(second).toBe(first);
        expect(concurrent).toBe(first);
        expect(harness.supervise).toHaveBeenCalledTimes(1);
        expect(resolveDeclaredSecret).toHaveBeenCalledTimes(2);
        expect(firstHealthProbeHeader).toMatch(/^Basic \S+$/u);
        expect(secondHealthProbeHeader).toMatch(/^Basic \S+$/u);
        expect(secondHealthProbeHeader).not.toBe(firstHealthProbeHeader);
        // The probe moves with the credential without minting a competing
        // semantic entry for the same attached server.
        expect(harness.supervise.mock.calls[0]?.[0]?.mode).toMatchObject({
            kind: 'externalAttach',
        });
    });

    it('re-resolves a declared secret for every exact request and health probe', async () => {
        let recorded: string | null = 'first-recorded-secret';
        const hostFetch = vi.fn<typeof globalThis.fetch>(async () =>
            new Response('[]', { status: 200 }));
        const resolveDeclaredSecret = vi.fn(async () => declaredSecretLease(recorded));
        const harness = createAttachHarness({
            hostFetch,
            resolveDeclaredSecret,
        });
        const services = harness.owner.bindScope(harness.scope, exec);
        const handle = await services.supervise({
            ...ATTACH_SPEC,
            clientAccess: {
                kind: 'declaredSecretBasic',
                username: 'opencode',
                passwordSecretId: 'opencodeServerPassword',
            },
        });
        const processSpec = harness.supervise.mock.calls[0]?.[0];
        if (processSpec?.healthCheck?.kind !== 'http') {
            throw new Error('expected an HTTP health check');
        }
        expect(processSpec.healthCheck.resolveHeaders).toEqual(
            expect.any(Function),
        );
        expect(processSpec.healthCheck.headers?.authorization).toBeUndefined();
        const resolveHealthHeaders = processSpec.healthCheck.resolveHeaders;
        if (!resolveHealthHeaders) {
            throw new Error('expected a current declared-secret health resolver');
        }
        const basic = (value: string): string => `Basic ${Buffer.from(
            `opencode:${value}`,
            'utf8',
        ).toString('base64')}`;

        expect(resolveDeclaredSecret).not.toHaveBeenCalled();
        await expect(resolveHealthHeaders()).resolves.toMatchObject({
            headers: { authorization: basic('first-recorded-secret') },
        });
        await handle.request({ pathAndQuery: '/session?limit=50' });
        expect(new Headers(hostFetch.mock.calls[0]?.[1]?.headers).get(
            'authorization',
        )).toBe(basic('first-recorded-secret'));

        recorded = 'rotated-recorded-secret';
        await expect(resolveHealthHeaders()).resolves.toMatchObject({
            headers: { authorization: basic('rotated-recorded-secret') },
        });
        await handle.request({ pathAndQuery: '/session?limit=50' });
        expect(new Headers(hostFetch.mock.calls[1]?.[1]?.headers).get(
            'authorization',
        )).toBe(basic('rotated-recorded-secret'));

        recorded = null;
        await expect(resolveHealthHeaders()).resolves.toMatchObject({
            headers: {},
        });
        const requestsBeforeRemoval = hostFetch.mock.calls.length;
        await expect(handle.request({
            pathAndQuery: '/session?limit=50',
        })).resolves.toMatchObject({ ok: true });
        expect(hostFetch).toHaveBeenCalledTimes(requestsBeforeRemoval + 1);
        expect(new Headers(hostFetch.mock.calls.at(-1)?.[1]?.headers).get(
            'authorization',
        )).toBeNull();

        recorded = '';
        await expect(resolveHealthHeaders()).resolves.toMatchObject({
            headers: {},
        });
        const requestsBeforeEmptyValue = hostFetch.mock.calls.length;
        await expect(handle.request({
            pathAndQuery: '/session?limit=50',
        })).resolves.toMatchObject({ ok: true });
        expect(hostFetch).toHaveBeenCalledTimes(requestsBeforeEmptyValue + 1);
        expect(new Headers(hostFetch.mock.calls.at(-1)?.[1]?.headers).get(
            'authorization',
        )).toBeNull();
    });

    it('reuses the established attach entry while the recorded secret is unchanged', async () => {
        const resolveDeclaredSecret = vi.fn(async () => declaredSecretLease('stable-recorded-secret'));
        const harness = createAttachHarness({ resolveDeclaredSecret });
        const services = harness.owner.bindScope(harness.scope, exec);
        const spec = {
            ...ATTACH_SPEC,
            clientAccess: {
                kind: 'declaredSecretBasic' as const,
                username: 'opencode',
                passwordSecretId: 'opencodeServerPassword',
            },
        };

        const first = await services.supervise(spec);
        const second = await services.supervise(spec);

        expect(second).toBe(first);
        expect(harness.supervise).toHaveBeenCalledTimes(1);
        expect(resolveDeclaredSecret).not.toHaveBeenCalled();
    });

    it('fences a late older declared-secret read before an exact request can dispatch it', async () => {
        const olderRead = deferred<ReturnType<typeof declaredSecretLease>>();
        let currentRevision = 'fixture-secret-r1:old';
        const olderLease = declaredSecretLease(
            'older-secret',
            'fixture-secret-r1:old',
        );
        const newerLease = Object.freeze({
            ...declaredSecretLease(
                'newer-secret',
                'fixture-secret-r1:new',
            ),
            async isCurrent(signal?: AbortSignal) {
                return !signal?.aborted
                    && currentRevision === 'fixture-secret-r1:new';
            },
        });
        const olderLeaseWithCurrentness = Object.freeze({
            ...olderLease,
            async isCurrent(signal?: AbortSignal) {
                return !signal?.aborted
                    && currentRevision === 'fixture-secret-r1:old';
            },
        });
        const resolveDeclaredSecret = vi.fn(async () => {
            if (resolveDeclaredSecret.mock.calls.length === 1) {
                return await olderRead.promise;
            }
            return newerLease;
        });
        const hostFetch = vi.fn<typeof globalThis.fetch>(async () =>
            new Response('[]', { status: 200 }));
        const harness = createAttachHarness({
            hostFetch,
            resolveDeclaredSecret,
        });
        const handle = await harness.owner.bindScope(harness.scope, exec)
            .supervise({
                ...ATTACH_SPEC,
                clientAccess: {
                    kind: 'declaredSecretBasic',
                    username: 'opencode',
                    passwordSecretId: 'opencodeServerPassword',
                },
            });

        const olderRequest = handle.request({
            pathAndQuery: '/session?limit=50',
        });
        await vi.waitFor(() => {
            expect(resolveDeclaredSecret).toHaveBeenCalledTimes(1);
        });

        currentRevision = 'fixture-secret-r1:new';
        await expect(handle.request({
            pathAndQuery: '/session?limit=50',
        })).resolves.toMatchObject({ ok: true });

        olderRead.resolve(olderLeaseWithCurrentness);
        await expect(olderRequest).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(hostFetch).toHaveBeenCalledTimes(1);
        expect(new Headers(hostFetch.mock.calls[0]?.[1]?.headers).get(
            'authorization',
        )).toBe(`Basic ${Buffer.from('opencode:newer-secret', 'utf8').toString('base64')}`);
    });

    it('fails a declared-secret attach closed when no declared-secret authority exists', async () => {
        const harness = createAttachHarness();
        const services = harness.owner.bindScope(harness.scope, exec);

        await expect(services.supervise({
            ...ATTACH_SPEC,
            clientAccess: {
                kind: 'declaredSecretBasic',
                username: 'opencode',
                passwordSecretId: 'opencodeServerPassword',
            },
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(harness.supervise).not.toHaveBeenCalled();
    });

    it('fails closed when the real declared-secret resolver has no bound daemon read port', async () => {
        const hostFetch = vi.fn<typeof globalThis.fetch>(async () =>
            new Response('[]', { status: 200 }));
        const harness = createAttachHarness({
            hostFetch,
            resolveDeclaredSecret: createDeclaredManagedServiceSecretResolver(),
        });
        const handle = await harness.owner.bindScope(harness.scope, exec)
            .supervise({
                ...ATTACH_SPEC,
                clientAccess: {
                    kind: 'declaredSecretBasic',
                    username: 'opencode',
                    passwordSecretId: 'opencodeServerPassword',
                },
            });
        const processSpec = harness.supervise.mock.calls[0]?.[0];
        const resolveHealthHeaders = processSpec?.healthCheck?.kind === 'http'
            ? processSpec.healthCheck.resolveHeaders
            : undefined;
        if (!resolveHealthHeaders) {
            throw new Error('expected a current declared-secret health resolver');
        }

        const healthError = await resolveHealthHeaders().then(
            () => null,
            (error: unknown) => error,
        );
        const requestError = await handle.request({
            pathAndQuery: '/session?limit=50',
        }).then(
            () => null,
            (error: unknown) => error,
        );

        expect(healthError).toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(requestError).toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(hostFetch).not.toHaveBeenCalled();
    });

    it('rejects a credential embedded in the attached base URL', async () => {
        const resolveDeclaredSecret = vi.fn(async () => declaredSecretLease('hunter2'));
        const owner = createManagedServicesOwner({
            // The real supervisor host owns endpoint admission; a stub would
            // make this assertion vacuous.
            processSupervisorHost: createManagedServiceProcessSupervisorHost({
                custodyOwner: 'daemon',
            }),
            dependencies: Object.freeze({}) as never,
            resolveScope: (scope) => scope,
            registerRawForRedaction: vi.fn(),
            resolveDeclaredSecret,
        });
        const services = owner.bindScope({
            generation: 'generation-one',
            pluginId: 'happier.agent.opencode',
            contributionQualifiedId: 'happier.agent.opencode/agents/opencode',
            operationId: 'external-sessions:browse',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, exec);

        await expect(services.supervise({
            ...ATTACH_SPEC,
            mode: {
                kind: 'attach',
                baseUrl: 'http://opencode:hunter2@127.0.0.1:4312',
            },
            clientAccess: {
                kind: 'declaredSecretBasic',
                passwordSecretId: 'opencodeServerPassword',
            },
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_spec_invalid',
        });
    });
});
