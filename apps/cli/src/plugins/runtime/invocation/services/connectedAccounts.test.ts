import { describe, expect, it, vi } from 'vitest';
import type {
    PluginConnectedAccountBindingSummary,
    PluginConnectedAccountMaterialization,
    PluginConnectedAccountMaterializationKind,
    PluginConnectedAccountMaterializationRequest,
} from '@happier-dev/plugin-sdk/runtime';

import {
    createStablePluginConnectedAccountsHost,
    type StablePluginConnectedAccountsOwner,
} from './connectedAccounts';
import type { HostCurrentSessionInteractionsService } from '@/agent/runtime/state/currentSessionUiTypes';
import type {
    PluginConnectedAccountBindingScope,
    PluginInvocationServicesSeed,
} from './types';

const scope: PluginConnectedAccountBindingScope = Object.freeze({
    purpose: 'realtime_upstream',
    serviceRefs: Object.freeze([
        Object.freeze({ pluginId: 'acme.accounts', localId: 'openai' }),
    ]),
    operations: Object.freeze(['select' as const, 'use' as const]),
    materializationKinds: Object.freeze([
        'httpHeaders' as const,
        'environment' as const,
        'files' as const,
    ]),
});

function createSeed(options: Readonly<{
    currentSession?: PluginInvocationServicesSeed['currentSession'];
    session?: PluginInvocationServicesSeed['session'];
}> = {}) {
    const controller = new AbortController();
    let current = true;
    const seed: PluginInvocationServicesSeed = Object.freeze({
        plugin: Object.freeze({ id: 'acme.consumer', version: '1.0.0' }),
        contribution: Object.freeze({
            id: 'run',
            qualifiedId: 'acme.consumer/actions/run',
        }),
        generation: 'generation-1',
        correlationId: 'correlation-1',
        surface: 'cli',
        ...(options.session ? { session: options.session } : {}),
        ...(options.currentSession ? { currentSession: options.currentSession } : {}),
        signal: controller.signal,
        isGenerationCurrent: () => current,
    });
    return {
        seed,
        retire() {
            current = false;
            controller.abort();
        },
    };
}

function bindingSummary(): PluginConnectedAccountBindingSummary {
    return Object.freeze({
        purpose: scope.purpose,
        service: scope.serviceRefs[0]!,
        target: Object.freeze({ kind: 'group', displayName: 'Primary upstreams' }),
    });
}

function materialization(): PluginConnectedAccountMaterialization {
    return Object.freeze({
        kind: 'httpHeaders',
        headers: Object.freeze({ authorization: 'Bearer secret' }),
    });
}

function createOwner(overrides: Partial<StablePluginConnectedAccountsOwner> = {}): StablePluginConnectedAccountsOwner {
    return {
        getBinding: vi.fn(async () => bindingSummary()),
        requestSelection: vi.fn(async () => bindingSummary()),
        materialize: vi.fn(async () => materialization()),
        watch: vi.fn(() => Object.freeze({ dispose() {} })),
        ...overrides,
    };
}

describe('stable plugin Connected Accounts host', () => {
    it('delegates purpose-scoped reads, selection, and point-in-time materialization', async () => {
        const owner = createOwner();
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);

        await expect(service.getBinding(scope.purpose)).resolves.toEqual(bindingSummary());
        await expect(service.requestSelection({
            purpose: scope.purpose,
            reason: 'Choose an upstream',
        })).resolves.toEqual(bindingSummary());
        await expect(service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        })).resolves.toEqual(materialization());

        expect(owner.getBinding).toHaveBeenCalledWith(expect.objectContaining({
            purpose: {
                consumer: { pluginId: 'acme.consumer', localId: 'run' },
                purpose: scope.purpose,
            },
            serviceRefs: scope.serviceRefs,
        }));
        expect(owner.requestSelection).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'Choose an upstream',
        }));
        expect(owner.materialize).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({ kind: 'httpHeaders' }),
        }));
    });

    it('passes the existing current-session interaction owner only to explicit selection', async () => {
        const request = vi.fn() as HostCurrentSessionInteractionsService['request'];
        const currentSession = Object.freeze({
            interactions: Object.freeze({ request }),
        });
        const owner = createOwner();
        const { seed } = createSeed({ currentSession });
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);

        await service.getBinding(scope.purpose);
        await service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        });
        service.watch(scope.purpose, () => undefined).dispose();
        await service.requestSelection({
            purpose: scope.purpose,
            reason: 'Choose an upstream',
        });

        expect(owner.getBinding).not.toHaveBeenCalledWith(expect.objectContaining({ currentSession }));
        expect(owner.materialize).not.toHaveBeenCalledWith(expect.objectContaining({ currentSession }));
        expect(owner.watch).not.toHaveBeenCalledWith(expect.objectContaining({ currentSession }));
        expect(owner.requestSelection).toHaveBeenCalledWith(expect.objectContaining({
            assertGenerationCurrent: expect.any(Function),
            currentSession,
        }));
        const selectionInput = vi.mocked(owner.requestSelection).mock.calls[0]![0];
        expect(selectionInput.assertGenerationCurrent).not.toThrow();
    });

    it('identifies the consuming Agent session for reads, materialization, and watches', async () => {
        const owner = createOwner();
        const { seed } = createSeed({ session: { id: 'session-1' } });
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);

        await service.getBinding(scope.purpose);
        await service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        });
        service.watch(scope.purpose, () => undefined).dispose();

        expect(owner.getBinding).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
        }));
        expect(owner.materialize).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
        }));
        expect(owner.watch).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
        }));
    });

    it('denies undeclared purposes and enforces select/use per method', async () => {
        const owner = createOwner();
        const { seed } = createSeed();
        const selectOnly = Object.freeze({ ...scope, operations: Object.freeze(['select' as const]) });
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [selectOnly]);

        await expect(service.requestSelection({
            purpose: scope.purpose,
            reason: 'Choose an upstream',
        })).resolves.toEqual(bindingSummary());
        await expect(service.getBinding(scope.purpose)).rejects.toMatchObject({
            code: 'plugin_host_access_operation_denied',
        });
        await expect(service.materialize(scope.purpose, {
            kind: 'environment',
            keys: ['TOKEN'],
        })).rejects.toMatchObject({
            code: 'plugin_host_access_operation_denied',
        });
        expect(() => service.watch(scope.purpose, () => undefined)).toThrow(expect.objectContaining({
            code: 'plugin_host_access_operation_denied',
        }));
        await expect(service.requestSelection({
            purpose: 'undeclared',
            reason: 'Choose an upstream',
        })).rejects.toMatchObject({
            code: 'plugin_connected_account_purpose_undeclared',
        });
    });

    it('requires prior exact materialization-kind authority before calling the owner', async () => {
        const cases: readonly Readonly<{
            kind: PluginConnectedAccountMaterializationKind;
            request: PluginConnectedAccountMaterializationRequest;
            result: PluginConnectedAccountMaterialization;
        }>[] = [
            {
                kind: 'httpHeaders',
                request: {
                    kind: 'httpHeaders',
                    origin: 'https://api.example.test',
                    headerNames: ['authorization'],
                },
                result: { kind: 'httpHeaders', headers: { authorization: 'Bearer secret' } },
            },
            {
                kind: 'environment',
                request: { kind: 'environment', keys: ['TOKEN'] },
                result: { kind: 'environment', env: { TOKEN: 'secret' } },
            },
            {
                kind: 'files',
                request: { kind: 'files', fileIds: ['credentials'] },
                result: {
                    kind: 'files',
                    files: { credentials: new TextEncoder().encode('secret') },
                },
            },
        ];

        for (const entry of cases) {
            const allowedOwner = createOwner({
                materialize: vi.fn(async () => entry.result),
            });
            const { seed } = createSeed();
            const allowed = createStablePluginConnectedAccountsHost(allowedOwner).bind(seed, [{
                ...scope,
                materializationKinds: Object.freeze([entry.kind]),
            }]);

            await expect(allowed.materialize(scope.purpose, entry.request))
                .resolves.toEqual(entry.result);
            expect(allowedOwner.materialize).toHaveBeenCalledOnce();

            const deniedOwner = createOwner({
                materialize: vi.fn(async () => entry.result),
            });
            const inspectionOnly = createStablePluginConnectedAccountsHost(deniedOwner).bind(seed, [{
                purpose: scope.purpose,
                serviceRefs: scope.serviceRefs,
                operations: scope.operations,
            }]);
            await expect(inspectionOnly.materialize(scope.purpose, entry.request))
                .rejects.toMatchObject({ code: 'plugin_host_access_operation_denied' });
            expect(deniedOwner.materialize).not.toHaveBeenCalled();
        }
    });

    it('rejects a mode-changing accessor before authorization or owner dispatch', async () => {
        let kindReads = 0;
        const request = Object.defineProperty({
            fileIds: ['credentials'],
            keys: ['TOKEN'],
        }, 'kind', {
            enumerable: true,
            get() {
                kindReads += 1;
                return kindReads === 1 ? 'files' : 'environment';
            },
        }) as unknown as PluginConnectedAccountMaterializationRequest;
        const owner = createOwner({
            materialize: vi.fn(async (input) => {
                if (input.request.kind === 'environment') {
                    return {
                        kind: 'environment' as const,
                        env: { TOKEN: 'unauthorized-secret' },
                    };
                }
                return {
                    kind: 'files' as const,
                    files: { credentials: new TextEncoder().encode('authorized-secret') },
                };
            }),
        });
        const { seed } = createSeed();
        const filesOnly = createStablePluginConnectedAccountsHost(owner).bind(seed, [{
            ...scope,
            materializationKinds: Object.freeze(['files' as const]),
        }]);

        await expect(filesOnly.materialize(scope.purpose, request)).rejects.toMatchObject({
            code: 'plugin_connected_account_binding_out_of_scope',
        });
        expect(owner.materialize).not.toHaveBeenCalled();
        expect(kindReads).toBe(0);
    });

    it('rechecks generation currentness after snapshotting a crafted request', async () => {
        const invocation = createSeed();
        const request = new Proxy({
            kind: 'environment' as const,
            keys: ['TOKEN'],
        }, {
            ownKeys(target) {
                invocation.retire();
                return Reflect.ownKeys(target);
            },
        });
        const owner = createOwner({
            materialize: vi.fn(async () => ({
                kind: 'environment' as const,
                env: { TOKEN: 'stale-generation-secret' },
            })),
        });
        const service = createStablePluginConnectedAccountsHost(owner)
            .bind(invocation.seed, [scope]);

        await expect(service.materialize(scope.purpose, request)).rejects.toMatchObject({
            code: 'plugin_final_generation_retired',
        });
        expect(owner.materialize).not.toHaveBeenCalled();
    });

    it('rechecks generation currentness after composing plugin operation signals before every async owner dispatch', async () => {
        const cases = [
            {
                ownerMethod: 'getBinding' as const,
                invoke: (
                    service: ReturnType<ReturnType<typeof createStablePluginConnectedAccountsHost>['bind']>,
                    signal: AbortSignal,
                ) => service.getBinding(scope.purpose, { signal }),
            },
            {
                ownerMethod: 'requestSelection' as const,
                invoke: (
                    service: ReturnType<ReturnType<typeof createStablePluginConnectedAccountsHost>['bind']>,
                    signal: AbortSignal,
                ) => service.requestSelection({
                    purpose: scope.purpose,
                    reason: 'Choose an upstream',
                }, { signal }),
            },
            {
                ownerMethod: 'materialize' as const,
                invoke: (
                    service: ReturnType<ReturnType<typeof createStablePluginConnectedAccountsHost>['bind']>,
                    signal: AbortSignal,
                ) => service.materialize(scope.purpose, {
                    kind: 'environment',
                    keys: ['TOKEN'],
                }, { signal }),
            },
        ];

        for (const entry of cases) {
            const invocation = createSeed();
            const owner = createOwner();
            const service = createStablePluginConnectedAccountsHost(owner)
                .bind(invocation.seed, [scope]);
            const craftedSignal = {
                addEventListener() {
                    invocation.retire();
                },
                removeEventListener() {},
                get aborted() {
                    return false;
                },
            } as unknown as AbortSignal;

            await expect(entry.invoke(service, craftedSignal)).rejects.toMatchObject({
                code: 'plugin_final_generation_retired',
            });
            expect(owner[entry.ownerMethod]).not.toHaveBeenCalled();
        }
    });

    it('rechecks generation currentness after reading each request-selection input field', async () => {
        for (const retiringField of ['purpose', 'reason'] as const) {
            const invocation = createSeed();
            const owner = createOwner();
            let purposeReads = 0;
            let reasonReads = 0;
            const input = Object.defineProperties({}, {
                purpose: {
                    enumerable: true,
                    get() {
                        purposeReads += 1;
                        if (retiringField === 'purpose') invocation.retire();
                        return scope.purpose;
                    },
                },
                reason: {
                    enumerable: true,
                    get() {
                        reasonReads += 1;
                        if (retiringField === 'reason') invocation.retire();
                        return 'Choose an upstream';
                    },
                },
            }) as Parameters<ReturnType<
                ReturnType<typeof createStablePluginConnectedAccountsHost>['bind']
            >['requestSelection']>[0];
            const service = createStablePluginConnectedAccountsHost(owner)
                .bind(invocation.seed, [scope]);

            await expect(service.requestSelection(input)).rejects.toMatchObject({
                code: 'plugin_final_generation_retired',
            });
            expect(owner.requestSelection).not.toHaveBeenCalled();
            expect(purposeReads).toBe(1);
            expect(reasonReads).toBe(retiringField === 'purpose' ? 0 : 1);
        }
    });

    it('keeps use-authorized non-disclosure inspection available without raw materialization authority', async () => {
        const owner = createOwner();
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [{
            purpose: scope.purpose,
            serviceRefs: scope.serviceRefs,
            operations: Object.freeze(['use' as const]),
        }]);

        await expect(service.getBinding(scope.purpose)).resolves.toEqual(bindingSummary());
        const subscription = service.watch(scope.purpose, () => undefined);
        await Promise.resolve();
        subscription.dispose();
        await expect(service.materialize(scope.purpose, {
            kind: 'files',
            fileIds: ['credentials'],
        })).rejects.toMatchObject({ code: 'plugin_host_access_operation_denied' });
        expect(owner.getBinding).toHaveBeenCalledOnce();
        expect(owner.watch).toHaveBeenCalledOnce();
        expect(owner.materialize).not.toHaveBeenCalled();
    });

    it('registers every materialized credential form for generation-scoped log redaction', async () => {
        const registerForRedaction = vi.fn();
        const owner = createOwner({
            materialize: vi.fn(async (input) => {
                if (input.request.kind === 'httpHeaders') {
                    return Object.freeze({
                        kind: 'httpHeaders' as const,
                        headers: Object.freeze({
                            authorization: 'Bearer header-secret',
                            'x-account': 'account-secret',
                        }),
                    });
                }
                if (input.request.kind === 'environment') {
                    return Object.freeze({
                        kind: 'environment' as const,
                        env: Object.freeze({ TOKEN: 'environment-secret' }),
                    });
                }
                return Object.freeze({
                    kind: 'files' as const,
                    files: Object.freeze({
                        credentials: new TextEncoder().encode('file-secret'),
                        opaque: new Uint8Array([0xfb, 0xff, 0xfe]),
                    }),
                });
            }),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner, {
            registerForRedaction,
        }).bind(seed, [scope]);

        await service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization', 'x-account'],
        });
        await service.materialize(scope.purpose, {
            kind: 'environment',
            keys: ['TOKEN'],
        });
        await service.materialize(scope.purpose, {
            kind: 'files',
            fileIds: ['credentials', 'opaque'],
        });

        expect(registerForRedaction.mock.calls.map(([, value]) => value)).toEqual(
            expect.arrayContaining([
                'Bearer header-secret',
                'account-secret',
                'environment-secret',
                'file-secret',
                'ZmlsZS1zZWNyZXQ=',
                '66696c652d736563726574',
                '+//+',
                '-__-',
                'fbfffe',
            ]),
        );
        expect(registerForRedaction.mock.calls.every(([registeredSeed]) => registeredSeed === seed)).toBe(true);
    });

    it('returns bounded point-in-time copies and registers redaction from those copies', async () => {
        const sourceHeaders = { authorization: 'Bearer original-header' };
        const sourceEnvironment = { TOKEN: 'original-environment' };
        const sourceFile = new TextEncoder().encode('original-file');
        const sourceFiles = { credentials: sourceFile };
        const registerForRedaction = vi.fn();
        const owner = createOwner({
            materialize: vi.fn(async (input) => {
                if (input.request.kind === 'httpHeaders') {
                    return { kind: 'httpHeaders' as const, headers: sourceHeaders };
                }
                if (input.request.kind === 'environment') {
                    return { kind: 'environment' as const, env: sourceEnvironment };
                }
                return { kind: 'files' as const, files: sourceFiles };
            }),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner, {
            registerForRedaction,
        }).bind(seed, [scope]);

        const headers = await service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        });
        const environment = await service.materialize(scope.purpose, {
            kind: 'environment',
            keys: ['TOKEN'],
        });
        const files = await service.materialize(scope.purpose, {
            kind: 'files',
            fileIds: ['credentials'],
        });

        sourceHeaders.authorization = 'Bearer mutated-header';
        sourceEnvironment.TOKEN = 'mutated-environment';
        sourceFile.fill(0);
        sourceFiles.credentials = new TextEncoder().encode('mutated-file');

        expect(headers).toEqual({
            kind: 'httpHeaders',
            headers: { authorization: 'Bearer original-header' },
        });
        expect(environment).toEqual({
            kind: 'environment',
            env: { TOKEN: 'original-environment' },
        });
        expect(files.kind === 'files' ? new TextDecoder().decode(files.files.credentials) : null)
            .toBe('original-file');
        expect(Object.isFrozen(headers)).toBe(true);
        expect(headers.kind === 'httpHeaders' && Object.isFrozen(headers.headers)).toBe(true);
        expect(Object.isFrozen(environment)).toBe(true);
        expect(environment.kind === 'environment' && Object.isFrozen(environment.env)).toBe(true);
        expect(Object.isFrozen(files)).toBe(true);
        expect(files.kind === 'files' && Object.isFrozen(files.files)).toBe(true);
        expect(registerForRedaction.mock.calls.map(([, value]) => value)).toEqual(
            expect.arrayContaining([
                'Bearer original-header',
                'original-environment',
                'original-file',
            ]),
        );
        expect(registerForRedaction.mock.calls.map(([, value]) => value)).not.toEqual(
            expect.arrayContaining([
                'Bearer mutated-header',
                'mutated-environment',
                'mutated-file',
            ]),
        );
    });

    it('rejects producer materialization outside the requested kind and key bounds', async () => {
        const { seed } = createSeed();
        const cases: readonly Readonly<{
            request:
                | { kind: 'httpHeaders'; origin: string; headerNames: readonly string[] }
                | { kind: 'environment'; keys: readonly string[] }
                | { kind: 'files'; fileIds: readonly string[] };
            result: PluginConnectedAccountMaterialization;
        }>[] = [
            {
                request: {
                    kind: 'httpHeaders',
                    origin: 'https://api.example.test',
                    headerNames: ['authorization'],
                },
                result: { kind: 'environment', env: { TOKEN: 'secret' } },
            },
            {
                request: {
                    kind: 'httpHeaders',
                    origin: 'https://api.example.test',
                    headerNames: ['authorization'],
                },
                result: {
                    kind: 'httpHeaders',
                    headers: {
                        Authorization: 'Bearer allowed-case-insensitively',
                        'x-unrequested-secret': 'secret',
                    },
                },
            },
            {
                request: { kind: 'environment', keys: ['TOKEN'] },
                result: {
                    kind: 'environment',
                    env: { TOKEN: 'allowed', EXTRA_SECRET: 'secret' },
                },
            },
            {
                request: { kind: 'files', fileIds: ['credentials'] },
                result: {
                    kind: 'files',
                    files: {
                        credentials: new Uint8Array([1]),
                        unrequested: new Uint8Array([2]),
                    },
                },
            },
        ];

        for (const entry of cases) {
            const owner = createOwner({
                materialize: vi.fn(async () => entry.result),
            });
            const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);
            await expect(service.materialize(scope.purpose, entry.request)).rejects.toMatchObject({
                code: 'plugin_connected_account_binding_out_of_scope',
            });
        }
    });

    it('rechecks generation currentness after snapshotting a crafted producer result', async () => {
        const invocation = createSeed();
        const result = Object.defineProperty({
            kind: 'httpHeaders' as const,
        }, 'headers', {
            enumerable: true,
            get() {
                invocation.retire();
                return { authorization: 'Bearer stale-generation-secret' };
            },
        }) as PluginConnectedAccountMaterialization;
        const owner = createOwner({
            materialize: vi.fn(async () => result),
        });
        const service = createStablePluginConnectedAccountsHost(owner)
            .bind(invocation.seed, [scope]);

        await expect(service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        })).rejects.toMatchObject({
            code: 'plugin_final_generation_retired',
        });
    });

    it('rejects a materialization whose invocation retires while the owner is pending', async () => {
        let resolveMaterialization: (
            value: PluginConnectedAccountMaterialization,
        ) => void = () => undefined;
        const owner = createOwner({
            materialize: vi.fn(async () => await new Promise<
                PluginConnectedAccountMaterialization
            >((resolve) => {
                resolveMaterialization = resolve;
            })),
        });
        const invocation = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner)
            .bind(invocation.seed, [scope]);

        const pending = service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        });
        await vi.waitFor(() => expect(owner.materialize).toHaveBeenCalledOnce());
        invocation.retire();
        resolveMaterialization(materialization());

        await expect(pending).rejects.toMatchObject({
            code: 'plugin_final_generation_retired',
        });
    });

    it('registers before one initial resync, coalesces invalidations, and reschedules changes during delivery', async () => {
        let invalidate: (() => void) | null = null;
        let registered = false;
        const dispose = vi.fn();
        const owner = createOwner({
            watch: vi.fn((input) => {
                invalidate = input.listener;
                input.listener();
                registered = true;
                return Object.freeze({ dispose });
            }),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);
        const events: string[] = [];
        let invalidatedDuringDelivery = false;

        const subscription = service.watch(scope.purpose, (event) => {
            expect(registered).toBe(true);
            events.push(event.kind);
            if (!invalidatedDuringDelivery) {
                invalidatedDuringDelivery = true;
                invalidate?.();
                invalidate?.();
            }
        });

        expect(events).toEqual([]);
        await Promise.resolve();
        expect(events).toEqual(['resync']);
        await Promise.resolve();
        expect(events).toEqual(['resync', 'resync']);

        subscription.dispose();
        (invalidate as (() => void) | null)?.();
        await Promise.resolve();
        expect(events).toEqual(['resync', 'resync']);
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('delivers an invalidation that arrives before the initial resync as a separate resync', async () => {
        let invalidate: (() => Promise<void>) | null = null;
        const owner = createOwner({
            watch: vi.fn((input) => {
                invalidate = input.listener;
                return Object.freeze({ dispose() {} });
            }),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);
        const delivered: string[] = [];

        const subscription = service.watch(scope.purpose, (event) => {
            delivered.push(event.kind);
        });
        const invalidationDelivered = (
            invalidate as (() => Promise<void>) | null
        )?.();

        expect(delivered).toEqual([]);
        await invalidationDelivered;
        expect(delivered).toEqual(['resync', 'resync']);

        subscription.dispose();
    });

    it('serializes async resync delivery and coalesces invalidations while the listener is pending', async () => {
        let invalidate: (() => void) | null = null;
        const owner = createOwner({
            watch: vi.fn((input) => {
                invalidate = () => {
                    void input.listener();
                };
                return Object.freeze({ dispose() {} });
            }),
        });
        const { seed } = createSeed({ session: { id: 'session-1' } });
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);
        const releases: Array<() => void> = [];
        const delivered: string[] = [];

        const subscription = service.watch(scope.purpose, async () => {
            delivered.push('resync');
            await new Promise<void>((resolve) => releases.push(resolve));
        });

        await vi.waitFor(() => expect(delivered).toEqual(['resync']));
        (invalidate as (() => void) | null)?.();
        (invalidate as (() => void) | null)?.();
        await Promise.resolve();
        await Promise.resolve();
        expect(delivered).toEqual(['resync']);

        releases.shift()?.();
        await vi.waitFor(() => expect(delivered).toEqual(['resync', 'resync']));
        releases.shift()?.();
        subscription.dispose();
    });

    it('retires the invocation capability and its subscriptions with the consumer generation', async () => {
        const dispose = vi.fn();
        const owner = createOwner({
            watch: vi.fn(() => Object.freeze({ dispose })),
        });
        const invocation = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(invocation.seed, [scope]);
        service.watch(scope.purpose, () => undefined);

        invocation.retire();

        expect(dispose).toHaveBeenCalledOnce();
        await expect(service.getBinding(scope.purpose)).rejects.toMatchObject({
            code: 'plugin_final_generation_retired',
        });
        await expect(service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        })).rejects.toMatchObject({
            code: 'plugin_final_generation_retired',
        });
        expect(owner.materialize).not.toHaveBeenCalled();
    });

    it('synchronously disposes active watches when the executable registry retires its consumers', () => {
        const dispose = vi.fn();
        const owner = createOwner({
            watch: vi.fn(() => Object.freeze({ dispose })),
        });
        const invocation = createSeed();
        const host = createStablePluginConnectedAccountsHost(owner);
        host.bind(invocation.seed, [scope]).watch(scope.purpose, () => undefined);

        host.retire();

        expect(dispose).toHaveBeenCalledOnce();
    });
});
