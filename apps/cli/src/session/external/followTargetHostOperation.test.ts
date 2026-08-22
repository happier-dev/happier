import { describe, expect, it, vi } from 'vitest';

import type { PluginAgentContributionV2 } from '@happier-dev/protocol';

import { createExternalSessionFollowTargetHostOperation } from './followTargetHostOperation';
import type {
    ExternalSessionFollowProviderOps,
    ExternalSessionProviderOps,
} from './providerOps';

const contribution = {
    id: 'codex',
    title: 'Codex',
    runtime: { kind: 'custom' },
    primary: 'sessions',
    capabilities: {
        sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
    },
    surfaces: {
        externalSession: {
            sources: [{
                sourceKind: 'codexHome',
                terminalFollow: { userRowClassification: 'explicitV1' },
                schema: {
                    fields: [
                        { name: 'kind', kind: 'literal', value: 'codexHome' },
                        { name: 'home', kind: 'enum', values: ['user'] },
                        { name: 'homePath', kind: 'string', optional: true },
                    ],
                },
                key: {
                    segments: [
                        { kind: 'literal', value: 'codexHome' },
                        { kind: 'homeMode', field: 'home' },
                        { kind: 'field', field: 'homePath' },
                    ],
                },
                instances: [{
                    kind: 'default',
                    constants: { home: 'user' },
                }],
            }],
        },
    },
} satisfies PluginAgentContributionV2;

const agent = Object.freeze({
    id: 'codex',
    identity: Object.freeze({
        pluginId: 'happier.codex',
        localId: 'codex',
    }),
    richDefinition: Object.freeze({
        provenance: 'first_party' as const,
        definition: contribution,
    }),
});

function request(overrides: Readonly<Record<string, unknown>> = {}) {
    return {
        pluginId: 'happier.codex',
        contributionId: 'codex',
        generationId: 'generation-1',
        sessionId: 'session-1',
        machineId: 'machine-1',
        accountRevision: 'account-1',
        remoteSessionId: 'remote-1',
        isCurrent: () => true,
        ...overrides,
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function isAbortedSignal(signal: AbortSignal | null): boolean {
    return signal?.aborted === true;
}

describe('external-session provider-session follow target host operation', () => {
    it('resolves one exact target from the bound daemon generation without listing candidates', async () => {
        const listCandidates = vi.fn();
        const providerOps: ExternalSessionFollowProviderOps & Pick<
            ExternalSessionProviderOps,
            'listCandidates'
        > = {
            validateSource: async ({ source }) => ({ ok: true, source }),
            resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
                source: {
                    ...source,
                    homePath: '/canonical/codex',
                },
                remoteSessionId,
                linkData: {},
            }),
            listCandidates,
            pageTranscript: async () => ({
                items: [],
                nextCursor: null,
                tailCursor: null,
                hasMore: false,
                truncated: false,
            }),
            readAfterTranscript: async () => ({
                outcome: 'already_current',
            }),
        };
        const release = vi.fn(async () => undefined);
        let accountRevision = 'account-1';
        const operation = createExternalSessionFollowTargetHostOperation({
            machineId: 'machine-1',
            dependencies: {
                acquireRuntimeContext: async () => ({
                    pluginId: 'happier.codex',
                    agentId: 'codex',
                    generationId: 'generation-1',
                    agent,
                    providerOps,
                    retirementSignal: new AbortController().signal,
                    isCurrent: () => true,
                    release,
                }),
                readAccount: async () => ({ connectedServicesV2: [] }),
                readAccountRevision: () => accountRevision,
                readAgentSettings: () => ({}),
                readActiveServerId: () => 'cloud',
            },
        });

        await expect(operation.execute(request())).resolves.toEqual({
            status: 'resolved',
            ref: {
                agentId: 'codex',
                sourceId: 'codexHome:user:',
                remoteSessionId: 'remote-1',
            },
            source: {
                kind: 'codexHome',
                home: 'user',
                homePath: '/canonical/codex',
            },
        });
        expect(listCandidates).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();

        accountRevision = 'account-2';
        await expect(operation.execute(request())).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_generation_retired',
        });
        expect(listCandidates).not.toHaveBeenCalled();
    });

    it('bounds the account read within the inherited terminal admission deadline', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(10_000));
        const pendingAccount = deferred<{
            connectedServicesV2: [];
        }>();
        const release = vi.fn(async () => undefined);
        let accountSignal: AbortSignal | null = null;
        const resolveLinkIdentity = vi.fn(async ({ source, remoteSessionId }) => ({
            source,
            remoteSessionId,
            linkData: {},
        }));
        const providerOps: ExternalSessionFollowProviderOps = {
            validateSource: async ({ source }) => ({ ok: true, source }),
            resolveLinkIdentity,
            pageTranscript: async () => ({
                items: [],
                nextCursor: null,
                tailCursor: null,
                hasMore: false,
                truncated: false,
            }),
            readAfterTranscript: async () => ({ outcome: 'already_current' }),
        };
        const operation = createExternalSessionFollowTargetHostOperation({
            machineId: 'machine-1',
            dependencies: {
                acquireRuntimeContext: async () => ({
                    pluginId: 'happier.codex',
                    agentId: 'codex',
                    generationId: 'generation-1',
                    agent,
                    providerOps,
                    retirementSignal: new AbortController().signal,
                    isCurrent: () => true,
                    release,
                }),
                readAccount: async (_agent, signal) => {
                    accountSignal = signal;
                    return await pendingAccount.promise;
                },
                readAccountRevision: () => 'account-1',
                readAgentSettings: () => ({}),
                readActiveServerId: () => 'cloud',
            },
        });
        let outcome: Awaited<ReturnType<typeof operation.execute>> | null = null;
        const execution = operation.execute(request({
            admissionDeadlineAtMs: 10_001,
        })).then((value) => {
            outcome = value;
            return value;
        });

        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(accountSignal).toBeInstanceOf(AbortSignal);

            await vi.advanceTimersByTimeAsync(1);

            expect(outcome).toEqual({
                status: 'unavailable',
                code: 'plugin_operation_deadline_exceeded',
            });
            expect(isAbortedSignal(accountSignal)).toBe(true);
            expect(resolveLinkIdentity).not.toHaveBeenCalled();
        } finally {
            pendingAccount.resolve({ connectedServicesV2: [] });
            await vi.advanceTimersByTimeAsync(0);
            await execution;
            vi.useRealTimers();
        }

        expect(release).toHaveBeenCalledOnce();
    });

    it('releases a runtime context that arrives after the terminal admission deadline', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(10_000));
        const pendingContext = deferred<{
            pluginId: string;
            agentId: string;
            generationId: string;
            agent: typeof agent;
            providerOps: ExternalSessionFollowProviderOps;
            retirementSignal: AbortSignal;
            isCurrent(): boolean;
            release(): Promise<void>;
        } | null>();
        const release = vi.fn(async () => undefined);
        const providerOps: ExternalSessionFollowProviderOps = {
            validateSource: async ({ source }) => ({ ok: true, source }),
            resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
                source,
                remoteSessionId,
                linkData: {},
            }),
            pageTranscript: async () => ({
                items: [],
                nextCursor: null,
                tailCursor: null,
                hasMore: false,
                truncated: false,
            }),
            readAfterTranscript: async () => ({ outcome: 'already_current' }),
        };
        const operation = createExternalSessionFollowTargetHostOperation({
            machineId: 'machine-1',
            dependencies: {
                acquireRuntimeContext: async () => await pendingContext.promise,
                readAccount: async () => ({ connectedServicesV2: [] }),
                readAccountRevision: () => 'account-1',
                readAgentSettings: () => ({}),
                readActiveServerId: () => 'cloud',
            },
        });
        let outcome: Awaited<ReturnType<typeof operation.execute>> | null = null;
        const execution = operation.execute(request({
            admissionDeadlineAtMs: 10_001,
        })).then((value) => {
            outcome = value;
            return value;
        });

        try {
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(1);

            expect(outcome).toEqual({
                status: 'unavailable',
                code: 'plugin_operation_deadline_exceeded',
            });

            pendingContext.resolve({
                pluginId: 'happier.codex',
                agentId: 'codex',
                generationId: 'generation-1',
                agent,
                providerOps,
                retirementSignal: new AbortController().signal,
                isCurrent: () => true,
                release,
            });
            await vi.advanceTimersByTimeAsync(0);
            await execution;
        } finally {
            vi.useRealTimers();
        }

        expect(release).toHaveBeenCalledOnce();
    });
});
