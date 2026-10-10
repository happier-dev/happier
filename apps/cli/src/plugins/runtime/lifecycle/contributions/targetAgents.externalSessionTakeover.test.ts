import { describe, expect, it, vi } from 'vitest';

import type {
    AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
    AgentExternalSessionTakeoverContribution,
    AgentExternalSessionTakeoverResolveLaunchRequest,
    AgentExternalSessionTakeoverResolveLaunchResult,
} from '@happier-dev/plugin-sdk/sessions/external';

import type { ActivationTarget } from '../activation/targets';
import type { ContributionRuntimeRegistration } from '../../api/registrationRightsHost';
import {
    createTargetAgentRuntimeRegistry,
} from './targetAgents.testkit';

const TEST_RETIREMENT_SIGNAL = new AbortController().signal;

const externalSessions = Object.freeze({
    resolveSource: async ({ source }) => ({
        ok: true as const,
        value: { source },
    }),
    listCandidates: async () => ({
        ok: true as const,
        value: { candidates: [], nextCursor: null },
    }),
    resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
        ok: true as const,
        value: { source, remoteSessionId, linkData: {} },
    }),
    resolveLinkedIdentity: async ({ source, remoteSessionId, linkData }) => ({
        ok: true as const,
        value: { source, remoteSessionId, linkData },
    }),
    pageTranscript: async () => ({
        ok: true as const,
        value: { items: [], nextCursor: null },
    }),
    readAfterTranscript: async () => ({
        ok: true as const,
        value: { outcome: 'already_current' as const },
    }),
}) satisfies AgentExternalSessionsContribution;

function target(): ActivationTarget {
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: 'acme.agent.fixture',
        manifestPath: '/plugins/acme.agent.fixture/plugin.json',
        daemonEntryPath: '/plugins/acme.agent.fixture/daemon.js',
        devDaemonEntryPath: null,
        sourceSpec: {
            kind: 'path',
            locator: '/plugins/acme.agent.fixture',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        manifest: { version: '0.0.0' },
    } as unknown as ActivationTarget;
}

function request(
    signal: AbortSignal = new AbortController().signal,
): AgentExternalSessionTakeoverResolveLaunchRequest {
    return {
        signal,
        deadlineAtMs: Date.now() + 60_000,
        maxSerializedBytes: 262_144,
        linkedSessionId: 'linked-session-1',
        transcriptStorage: 'persisted',
        source: { kind: 'fixture' },
        remoteSessionId: 'remote-session-1',
        linkData: {},
        targetDirectory: '/local/selected/workspace',
        linkedDirectory: '/linked/workspace',
    };
}

async function registry(params: Readonly<{
    takeover: AgentExternalSessionTakeoverContribution;
    isOccurrenceCurrent?: () => boolean;
    retirementSignal?: AbortSignal;
}>) {
    return await createTargetAgentRuntimeRegistry({
        agents: [{
            id: 'assistant',
            identity: {
                pluginId: 'acme.agent.fixture',
                localId: 'assistant',
            },
            pluginId: 'acme.agent.fixture',
        }],
        activationTargets: [target()],
        targetRegistrations: [{
            pluginId: 'acme.agent.fixture',
            occurrenceId: 'generation-7',
            registration: {
                family: 'agents',
                localId: 'assistant',
                value: {
                    externalSessions,
                    externalSessionTakeover: params.takeover,
                },
            } as ContributionRuntimeRegistration,
        }],
        isOccurrenceCurrent: params.isOccurrenceCurrent ?? (() => true),
        retirementSignal:
            params.retirementSignal ?? TEST_RETIREMENT_SIGNAL,
        onDuplicate: vi.fn(),
    });
}

describe('target Agent External Session takeover lease', () => {
    it('leases a private request-only bound facet on an auxiliary Agent aggregate', async () => {
        const resolveLaunch = vi.fn(async (...args: [
            AgentExternalSessionTakeoverResolveLaunchRequest,
        ]) => {
            expect(args).toHaveLength(1);
            expect(args[0]).toMatchObject({
                linkedSessionId: 'linked-session-1',
                transcriptStorage: 'persisted',
                remoteSessionId: 'remote-session-1',
                targetDirectory: '/local/selected/workspace',
                linkedDirectory: '/linked/workspace',
                deadlineAtMs: expect.any(Number),
                maxSerializedBytes: 262_144,
            });
            return {
                ok: true as const,
                value: {
                    runtimeDescriptorV1: {
                        v: 1 as const,
                        agentId: 'fixture.agent',
                        agent: { mode: 'resume' },
                    },
                    environmentVariables: { TAKEOVER: '1' },
                },
            };
        });
        const takeover = Object.freeze({ resolveLaunch });
        const admitted = await registry({ takeover });
        const lease = admitted.get('assistant');
        const occurrenceId = admitted.readPluginOccurrenceId('acme.agent.fixture');
        expect(occurrenceId).toBeDefined();

        expect(lease).toMatchObject({
            agentId: 'assistant',
            occurrenceId,
            hasPrimaryRuntime: false,
        });
        expect(lease?.externalSessionTakeover).toBeDefined();
        expect(lease?.externalSessionTakeover).not.toBe(takeover);
        await expect(
            lease?.externalSessionTakeover?.resolveLaunch(request()),
        ).resolves.toEqual({
            ok: true,
            value: {
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'fixture.agent',
                    agent: { mode: 'resume' },
                },
                environmentVariables: { TAKEOVER: '1' },
            },
        });
    });

    it('rejects malformed requests before invoking the leaf and malformed results after it', async () => {
        let result: unknown = {
            ok: true,
            value: { unexpected: true },
        };
        const resolveLaunch = vi.fn(async () => (
            result as Awaited<ReturnType<
                AgentExternalSessionTakeoverContribution['resolveLaunch']
            >>
        ));
        const takeover = (await registry({
            takeover: Object.freeze({ resolveLaunch }),
        })).get('assistant')?.externalSessionTakeover;
        if (!takeover) throw new Error('Expected takeover lease');

        await expect(takeover.resolveLaunch({
            ...request(),
            unexpected: true,
        } as AgentExternalSessionTakeoverResolveLaunchRequest)).rejects.toThrow();
        expect(resolveLaunch).not.toHaveBeenCalled();

        await expect(takeover.resolveLaunch(request())).rejects.toThrow();
        expect(resolveLaunch).toHaveBeenCalledOnce();

        result = {
            ok: true,
            value: {},
        };
        await expect(takeover.resolveLaunch(request())).resolves.toEqual(result);
    });

    it('carries a bounded public runtime descriptor and rejects an unrecognized takeover extension', async () => {
        const selectedSessionFile =
            '/home/lee/.pi/agent/sessions/workspace-a/pi-shared.jsonl';
        const publicResult = Object.freeze({
            ok: true as const,
            value: {
                runtimeDescriptorV1: {
                    v: 1 as const,
                    agentId: 'pi',
                    agent: {
                        providerSessionId: 'pi-shared',
                        sessionFile: selectedSessionFile,
                    },
                },
            },
        });
        const takeover = (await registry({
            takeover: Object.freeze({
                resolveLaunch: async () => publicResult as never,
            }),
        })).get('assistant')?.externalSessionTakeover;
        if (!takeover) throw new Error('Expected takeover lease');

        await expect(takeover.resolveLaunch(request())).resolves.toEqual({
            ok: true,
            value: publicResult.value,
        });

        const privateTakeover = (await registry({
            takeover: Object.freeze({
                resolveLaunch: async () => ({
                    ok: true as const,
                    value: {},
                    unrecognizedHostExtension: selectedSessionFile,
                }) as never,
            }),
        })).get('assistant')?.externalSessionTakeover;
        if (!privateTakeover) throw new Error('Expected private takeover lease');
        await expect(privateTakeover.resolveLaunch(request())).rejects.toThrow(
            /unknown fields/u,
        );
    });

    it('enforces both caller and host serialized-result ceilings', async () => {
        let result: AgentExternalSessionTakeoverResolveLaunchResult = {
            ok: true as const,
            value: {
                environmentVariables: { TAKEOVER: 'x'.repeat(512) },
            },
        };
        const takeover = (await registry({
            takeover: Object.freeze({
                resolveLaunch: async () => result,
            }),
        })).get('assistant')?.externalSessionTakeover;
        if (!takeover) throw new Error('Expected takeover lease');

        await expect(takeover.resolveLaunch({
            ...request(),
            maxSerializedBytes: 256,
        })).rejects.toThrow(/serialized-byte limit/u);

        result = {
            ok: true,
            value: {
                environmentVariables: Object.fromEntries(
                    Array.from({ length: 17 }, (_, index) => [
                        `TAKEOVER_${index}`,
                        'x'.repeat(16_384),
                    ]),
                ),
            },
        };
        await expect(takeover.resolveLaunch(request()))
            .rejects.toThrow(/serialized-byte limit/u);
    });

    it('measures the accepted canonical DTO rather than the plugin-owned object', async () => {
        const raw = Object.assign(Object.create(null), {
            ok: true as const,
            value: Object.assign(Object.create(null), {}),
        });
        const stringify = vi.spyOn(JSON, 'stringify');
        const takeover = (await registry({
            takeover: Object.freeze({ resolveLaunch: async () => raw }),
        })).get('assistant')?.externalSessionTakeover;
        if (!takeover) throw new Error('Expected takeover lease');

        await expect(takeover.resolveLaunch(request())).resolves.toEqual({
            ok: true,
            value: {},
        });
        const measured = stringify.mock.calls.at(-1)?.[0];
        expect(measured).not.toBe(raw);
        expect(measured).toEqual({
            ok: true,
            value: {},
        });
    });

    it.each(['cancelled', 'retired'] as const)(
        'rejects late callback settlement after the invocation is %s',
        async (terminal) => {
            let settle!: () => void;
            const callbackSettled = new Promise<void>((resolve) => {
                settle = resolve;
            });
            const resolveLaunch = vi.fn(async () => {
                await callbackSettled;
                return {
                    ok: true as const,
                    value: {},
                };
            });
            let current = true;
            const caller = new AbortController();
            const retirement = new AbortController();
            const takeover = (await registry({
                takeover: Object.freeze({ resolveLaunch }),
                isOccurrenceCurrent: () => current,
                retirementSignal: retirement.signal,
            })).get('assistant')?.externalSessionTakeover;
            if (!takeover) throw new Error('Expected takeover lease');

            const invocation = takeover.resolveLaunch(request(caller.signal));
            await vi.waitFor(() => {
                expect(resolveLaunch).toHaveBeenCalledOnce();
            });
            if (terminal === 'cancelled') {
                caller.abort();
            } else {
                current = false;
                retirement.abort();
            }

            await expect(invocation).rejects.toThrow(
                terminal === 'cancelled'
                    ? /cancelled/u
                    : /retired generation/u,
            );
            settle();
            await Promise.resolve();
            await Promise.resolve();
        },
    );

    it('preserves the caller takeover deadline beyond the former fifteen-second cutoff', async () => {
        vi.useFakeTimers();
        try {
            const startedAt = Date.now();
            let boundedRequest:
                | AgentExternalSessionTakeoverResolveLaunchRequest
                | undefined;
            const resolveLaunch = vi.fn(async (
                value: AgentExternalSessionTakeoverResolveLaunchRequest,
            ) => {
                boundedRequest = value;
                await new Promise<void>(() => undefined);
                return {
                    ok: true as const,
                    value: {},
                };
            });
            const takeover = (await registry({
                takeover: Object.freeze({ resolveLaunch }),
            })).get('assistant')?.externalSessionTakeover;
            if (!takeover) throw new Error('Expected takeover lease');

            const invocation = takeover.resolveLaunch(request());
            await Promise.resolve();
            expect(boundedRequest?.deadlineAtMs).toBe(startedAt + 60_000);
            const rejection = expect(invocation).rejects.toThrow(/timed out/u);
            await vi.advanceTimersByTimeAsync(60_000);
            await rejection;
            expect(boundedRequest?.signal.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
