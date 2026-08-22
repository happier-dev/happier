import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerInfoMock = vi.fn();
const loggerWarnMock = vi.fn();
const loggerDebugMock = vi.fn();

vi.mock('@/ui/logger', () => ({
    logger: {
        info: (...args: unknown[]) => loggerInfoMock(...args),
        warn: (...args: unknown[]) => loggerWarnMock(...args),
        debug: (...args: unknown[]) => loggerDebugMock(...args),
    },
}));

import {
    ExecutionRunConnectedServicesError,
    resolveExecutionRunConnectedServicesSelection,
    resolveExecutionRunConnectedServicesEnv,
} from './connectedServicesEnv';

const CONNECTED_BINDINGS = {
    v: 1,
    bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'profile', profileId: 'profile_1' },
    },
} as const;

const NATIVE_BINDINGS = {
    v: 1,
    bindingsByServiceId: {
        'openai-codex': { source: 'native' },
    },
} as const;

const CREDENTIALS = { token: 'token_1' } as never;

const MATERIALIZED_ENV_VALUE = '/materialized/run_1/codex-home';
const ACTIVATION_ID = '11111111-1111-4111-8111-111111111111';
const REGISTRATION = {
    v: 1 as const,
    activationId: ACTIVATION_ID,
    runKey: 'run_1',
    agentId: 'codex',
    materializationKey: 'run_1',
    connectedServicesBindings: CONNECTED_BINDINGS,
    connectedServiceSelectionsEnv: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: '{"v":1}' },
    sessionDirectory: '/tmp/project',
    materializedRoot: '/materialized/run_1',
};

function createDeps(overrides: Partial<{
    requestMaterialization: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    readCredentials: ReturnType<typeof vi.fn>;
    resolveSessionSpawnDefaults: ReturnType<typeof vi.fn>;
}> = {}) {
    const requestMaterialization = overrides.requestMaterialization ?? vi.fn(async () => ({
        ok: true as const,
        result: {
            activationId: ACTIVATION_ID,
            env: { CODEX_HOME: MATERIALIZED_ENV_VALUE },
            connectedServicesBindings: CONNECTED_BINDINGS,
            registration: REGISTRATION,
        },
    }));
    const release = overrides.release ?? vi.fn(async () => ({ ok: true as const, released: true }));
    const readCredentials = overrides.readCredentials ?? vi.fn(async () => CREDENTIALS);
    const resolveSessionSpawnDefaults = overrides.resolveSessionSpawnDefaults ?? vi.fn(async () => null);
    return { requestMaterialization, release, readCredentials, resolveSessionSpawnDefaults, runnerPid: 777 };
}

describe('resolveExecutionRunConnectedServicesEnv', () => {
    beforeEach(() => {
        loggerInfoMock.mockClear();
        loggerWarnMock.mockClear();
        loggerDebugMock.mockClear();
    });

    it('resolves a session default before materialization so Provider authorization can suppress competing native auth', async () => {
        const deps = createDeps({
            resolveSessionSpawnDefaults: vi.fn(async () => ({
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'profile',
                            profileId: 'default_profile',
                        },
                    },
                },
                connectedServicesUpdatedAt: 123,
            })),
        });

        await expect(resolveExecutionRunConnectedServicesSelection({
            backendId: 'codex',
            backendSourceKind: 'built_in',
            deps,
        })).resolves.toEqual({
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'default_profile',
                    },
                },
            },
            source: 'session_default',
            hadCredentials: true,
        });
        expect(deps.requestMaterialization).not.toHaveBeenCalled();
    });

    it('materializes an explicit connected selection through the daemon bridge', async () => {
        const deps = createDeps();

        const resolved = await resolveExecutionRunConnectedServicesEnv({
            runId: 'run_1',
            backendId: 'codex',
            backendSourceKind: 'built_in',
            connectedServices: CONNECTED_BINDINGS,
            cwd: '/tmp/project',
            deps,
        });

        expect(resolved?.env).toEqual({ CODEX_HOME: MATERIALIZED_ENV_VALUE });
        expect(resolved?.registration).toEqual(REGISTRATION);
        expect(deps.requestMaterialization).toHaveBeenCalledWith({
            runId: 'run_1',
            runnerPid: 777,
            agentId: 'codex',
            connectedServices: CONNECTED_BINDINGS,
            cwd: '/tmp/project',
        });
        // QA2-F02: explicit selections never consult the session defaulting owner.
        expect(deps.resolveSessionSpawnDefaults).not.toHaveBeenCalled();
    });

    it('QA2-F02: defaults through the SESSION spawn-defaulting owner (credentials-bootstrapped), never a runner settings snapshot', async () => {
        const deps = createDeps({
            resolveSessionSpawnDefaults: vi.fn(async () => ({
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': { source: 'connected', selection: 'profile', profileId: 'default_profile' },
                    },
                },
                connectedServicesUpdatedAt: 123,
            })),
        });

        const resolved = await resolveExecutionRunConnectedServicesEnv({
            runId: 'run_1',
            backendId: 'codex',
            backendSourceKind: 'built_in',
            cwd: '/tmp/project',
            deps,
        });

        expect(resolved?.env.CODEX_HOME).toBe(MATERIALIZED_ENV_VALUE);
        expect(deps.readCredentials).toHaveBeenCalledTimes(1);
        expect(deps.resolveSessionSpawnDefaults).toHaveBeenCalledWith({
            agentId: 'codex',
            credentials: CREDENTIALS,
        });
        const requested = deps.requestMaterialization.mock.calls[0]?.[0] as {
            connectedServices: { bindingsByServiceId: Record<string, unknown> };
        };
        expect(requested.connectedServices.bindingsByServiceId['openai-codex']).toEqual({
            source: 'connected',
            selection: 'profile',
            profileId: 'default_profile',
        });
    });

    it('RO-F5: resolves a bare per-service default and merges it UNDER an explicit pin for another service', async () => {
        const deps = createDeps({
            resolveSessionSpawnDefaults: vi.fn(async () => ({
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        openai: { source: 'connected', selection: 'group', groupId: 'team' },
                    },
                },
                connectedServicesUpdatedAt: 1,
            })),
        });

        await resolveExecutionRunConnectedServicesEnv({
            runId: 'run_1',
            backendId: 'codex',
            backendSourceKind: 'built_in',
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': { source: 'connected', selection: 'profile', profileId: 'explicit_pin' },
                },
            },
            connectedServicesDefaultServiceIds: ['openai'],
            cwd: '/tmp/project',
            deps,
        });

        const requested = deps.requestMaterialization.mock.calls[0]?.[0] as {
            connectedServices: { bindingsByServiceId: Record<string, unknown> };
        };
        // Explicit pin is preserved verbatim; the bare default is resolved and merged in alongside it.
        expect(requested.connectedServices.bindingsByServiceId['openai-codex']).toEqual({
            source: 'connected',
            selection: 'profile',
            profileId: 'explicit_pin',
        });
        expect(requested.connectedServices.bindingsByServiceId.openai).toEqual({
            source: 'connected',
            selection: 'group',
            groupId: 'team',
        });
    });

    it('RO-F5: a bare per-service default with no stored connected default fails closed', async () => {
        const deps = createDeps({
            // Session defaulting yields nothing for the requested service.
            resolveSessionSpawnDefaults: vi.fn(async () => null),
        });
        await expect(resolveExecutionRunConnectedServicesEnv({
            runId: 'run_1',
            backendId: 'codex',
            backendSourceKind: 'built_in',
            connectedServicesDefaultServiceIds: ['openai-codex'],
            cwd: '/tmp/project',
            deps,
        })).rejects.toBeInstanceOf(ExecutionRunConnectedServicesError);
        expect(deps.requestMaterialization).not.toHaveBeenCalled();
    });

    it('returns null without a bridge call when no connected selection applies', async () => {
        const deps = createDeps();

        // No explicit selection, session owner resolves no defaults.
        expect(await resolveExecutionRunConnectedServicesEnv({
            runId: 'run_1',
            backendId: 'codex',
            backendSourceKind: 'built_in',
            cwd: '/tmp/project',
            deps,
        })).toBeNull();

        // Explicitly native selection.
        expect(await resolveExecutionRunConnectedServicesEnv({
            runId: 'run_2',
            backendId: 'codex',
            backendSourceKind: 'built_in',
            connectedServices: NATIVE_BINDINGS,
            cwd: '/tmp/project',
            deps,
        })).toBeNull();

        // Explicit opt-out (null) suppresses defaulting entirely.
        expect(await resolveExecutionRunConnectedServicesEnv({
            runId: 'run_3',
            backendId: 'codex',
            backendSourceKind: 'built_in',
            connectedServices: null,
            cwd: '/tmp/project',
            deps,
        })).toBeNull();

        // Non-built-in backends never default into connected services.
        expect(await resolveExecutionRunConnectedServicesEnv({
            runId: 'run_4',
            backendId: 'my-configured-acp',
            backendSourceKind: 'configured',
            cwd: '/tmp/project',
            deps,
        })).toBeNull();

        expect(deps.requestMaterialization).not.toHaveBeenCalled();
    });

    it('proceeds native (null) without credentials and logs the decision', async () => {
        const deps = createDeps({ readCredentials: vi.fn(async () => null) });

        expect(await resolveExecutionRunConnectedServicesEnv({
            runId: 'run_1',
            backendId: 'codex',
            backendSourceKind: 'built_in',
            cwd: '/tmp/project',
            deps,
        })).toBeNull();

        expect(deps.resolveSessionSpawnDefaults).not.toHaveBeenCalled();
        expect(loggerInfoMock).toHaveBeenCalledWith(
            expect.stringContaining('proceeding native'),
            expect.objectContaining({ agentId: 'codex' }),
        );
    });

    it('fails closed when the daemon bridge rejects or is unreachable', async () => {
        const rejecting = createDeps({
            requestMaterialization: vi.fn(async () => ({
                ok: false as const,
                errorCode: 'connected_service_run_materialization_blocked',
                errorMessage: 'credential expired',
            })),
        });
        await expect(resolveExecutionRunConnectedServicesEnv({
            runId: 'run_1',
            backendId: 'codex',
            backendSourceKind: 'built_in',
            connectedServices: CONNECTED_BINDINGS,
            cwd: '/tmp/project',
            deps: rejecting,
        })).rejects.toBeInstanceOf(ExecutionRunConnectedServicesError);

        const unreachable = createDeps({
            requestMaterialization: vi.fn(async () => ({ error: 'No daemon running, no state file found' })),
        });
        await expect(resolveExecutionRunConnectedServicesEnv({
            runId: 'run_1',
            backendId: 'codex',
            backendSourceKind: 'built_in',
            connectedServices: CONNECTED_BINDINGS,
            cwd: '/tmp/project',
            deps: unreachable,
        })).rejects.toBeInstanceOf(ExecutionRunConnectedServicesError);
    });

    it('fails closed when an explicit connected selection targets a non-catalog backend', async () => {
        const deps = createDeps();
        await expect(resolveExecutionRunConnectedServicesEnv({
            runId: 'run_1',
            backendId: 'my-configured-acp',
            backendSourceKind: 'configured',
            connectedServices: CONNECTED_BINDINGS,
            cwd: '/tmp/project',
            deps,
        })).rejects.toBeInstanceOf(ExecutionRunConnectedServicesError);
        expect(deps.requestMaterialization).not.toHaveBeenCalled();
    });

    it('cleanup releases the run materialization exactly once', async () => {
        const deps = createDeps();
        const resolved = await resolveExecutionRunConnectedServicesEnv({
            runId: 'run_1',
            backendId: 'codex',
            backendSourceKind: 'built_in',
            connectedServices: CONNECTED_BINDINGS,
            cwd: '/tmp/project',
            deps,
        });

        await resolved?.cleanup();
        await resolved?.cleanup();
        expect(deps.release).toHaveBeenCalledTimes(1);
        expect(deps.release).toHaveBeenCalledWith({
            runId: 'run_1',
            runnerPid: 777,
            activationId: ACTIVATION_ID,
        });
    });

    it('shares concurrent cleanup and retries after a failed release', async () => {
        let unblockFirst!: () => void;
        const firstAttempt = new Promise<void>((resolve) => { unblockFirst = resolve; });
        const release = vi.fn()
            .mockImplementationOnce(async () => {
                await firstAttempt;
                throw new Error('daemon unavailable');
            })
            .mockResolvedValueOnce({ ok: true as const, released: true });
        const deps = createDeps({ release });
        const resolved = await resolveExecutionRunConnectedServicesEnv({
            runId: 'run_1',
            backendId: 'codex',
            backendSourceKind: 'built_in',
            connectedServices: CONNECTED_BINDINGS,
            cwd: '/tmp/project',
            deps,
        });

        const first = resolved!.cleanup();
        const concurrent = resolved!.cleanup();
        expect(release).toHaveBeenCalledTimes(1);
        unblockFirst();
        await expect(first).rejects.toThrow('daemon unavailable');
        await expect(concurrent).rejects.toThrow('daemon unavailable');

        await resolved!.cleanup();
        expect(release).toHaveBeenCalledTimes(2);
    });

    it('retains cleanup for retry when the daemon reports cleanup did not complete', async () => {
        const release = vi.fn()
            .mockResolvedValueOnce({ ok: true as const, released: false })
            .mockResolvedValueOnce({ ok: true as const, released: true });
        const resolved = await resolveExecutionRunConnectedServicesEnv({
            runId: 'run_1',
            backendId: 'codex',
            backendSourceKind: 'built_in',
            connectedServices: CONNECTED_BINDINGS,
            cwd: '/tmp/project',
            deps: createDeps({ release }),
        });

        await expect(resolved!.cleanup()).rejects.toThrow('cleanup did not complete');
        await resolved!.cleanup();
        expect(release).toHaveBeenCalledTimes(2);
    });

    describe('QA2-F03 decision logging (one line per run start; values never logged)', () => {
        it('logs the materialized decision with env-key NAMES only (no values, no bindings payloads)', async () => {
            const deps = createDeps();
            await resolveExecutionRunConnectedServicesEnv({
                runId: 'run_1',
                backendId: 'codex',
                backendSourceKind: 'built_in',
                connectedServices: CONNECTED_BINDINGS,
                cwd: '/tmp/project',
                deps,
            });

            expect(loggerInfoMock).toHaveBeenCalledTimes(1);
            const [message, payload] = loggerInfoMock.mock.calls[0] as [string, Record<string, unknown>];
            expect(message).toContain('materialized');
            expect(payload).toMatchObject({
                agentId: 'codex',
                runId: 'run_1',
                source: 'explicit',
                envKeys: ['CODEX_HOME'],
            });
            // Env VALUES must never reach any log payload.
            const serialized = JSON.stringify(loggerInfoMock.mock.calls) + JSON.stringify(loggerWarnMock.mock.calls);
            expect(serialized).not.toContain(MATERIALIZED_ENV_VALUE);
        });

        it('logs the native decision once when no selection resolves', async () => {
            const deps = createDeps();
            await resolveExecutionRunConnectedServicesEnv({
                runId: 'run_1',
                backendId: 'codex',
                backendSourceKind: 'built_in',
                cwd: '/tmp/project',
                deps,
            });

            expect(loggerInfoMock).toHaveBeenCalledTimes(1);
            const [message, payload] = loggerInfoMock.mock.calls[0] as [string, Record<string, unknown>];
            expect(message).toContain('proceeding native');
            expect(payload).toMatchObject({ agentId: 'codex', runId: 'run_1' });
        });

        it('logs a fail-closed warn (no secrets) when materialization fails', async () => {
            const deps = createDeps({
                requestMaterialization: vi.fn(async () => ({
                    ok: false as const,
                    errorCode: 'connected_service_run_materialization_blocked',
                    errorMessage: 'credential expired',
                })),
            });
            await expect(resolveExecutionRunConnectedServicesEnv({
                runId: 'run_1',
                backendId: 'codex',
                backendSourceKind: 'built_in',
                connectedServices: CONNECTED_BINDINGS,
                cwd: '/tmp/project',
                deps,
            })).rejects.toBeInstanceOf(ExecutionRunConnectedServicesError);

            expect(loggerWarnMock).toHaveBeenCalledWith(
                expect.stringContaining('failing run start closed'),
                expect.objectContaining({ agentId: 'codex', runId: 'run_1' }),
            );
        });
    });
});
