import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
    AgentExternalSessionHooksContribution,
    AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/sessions/external';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
    activate as activateClaude,
    PLUGIN_MANIFEST as CLAUDE_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-claude';

import {
    createQualifiedExternalSessionHookIngress,
    type QualifiedExternalSessionHookRuntimeLease,
} from './qualifiedExternalSessionHookIngress';
import {
    createBoundedAgentExternalSessionsContribution,
    type BoundedAgentExternalSessionsContribution,
} from '@/session/external/agentExternalSessionsInvocation';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

const roots: string[] = [];
const unavailableInvocationExec = createUnavailablePluginServices().exec;

function bindFixtureExternalSessions(
    contribution: AgentExternalSessionsContribution,
): BoundedAgentExternalSessionsContribution {
    return createBoundedAgentExternalSessionsContribution({
        contribution,
        identity: {
            pluginId: 'happier.agent.fixture',
            agentId: 'fixture-agent',
            generation: 'plugin-generation-1',
            contributionQualifiedId:
                'happier.agent.fixture/agents/fixture-agent',
            immutableGenerationId: null,
        },
        isCurrent: () => true,
        retirementSignal: new AbortController().signal,
        createInvocationExec: async () => unavailableInvocationExec,
    });
}

const installationVariant = {
    variantId: 'session-lifecycle-v1',
    targets: [{
        targetId: 'settings',
        format: 'hook_event_json_arrays_v1' as const,
        collectionId: 'hooks',
    }],
    events: [
        {
            eventId: 'session-stop',
            targetId: 'settings',
            nativeEventName: 'Stop',
            command: {
                kind: 'happier_observation_v1' as const,
                shellDialect: 'posix' as const,
            },
        },
        {
            eventId: 'session-stop-audit',
            targetId: 'settings',
            nativeEventName: 'Stop',
            command: {
                kind: 'happier_observation_v1' as const,
                shellDialect: 'posix' as const,
                matcher: 'audit',
            },
        },
    ],
} as const;

const source = {
    kind: 'fixtureSource',
    scope: 'project-1',
} as const;

const mappedFact = {
    kind: 'turn_phase' as const,
    value: 'idle' as const,
    evidenceClass: 'qualified_hook' as const,
    observedAtMs: 1_000,
    expiresAtMs: 2_000,
};

const nativePayload = {
    session_id: 'native-session-1',
    lifecycle: { final: true },
    prompt: 'trusted Agent leaf owns native parsing',
    tool_input: { command: 'still only reaches the trusted leaf' },
    transcript_path: '/native/agent/path',
    env: { NATIVE_AGENT_VALUE: 'opaque' },
} as const satisfies JsonValue;

function createRuntimeLease(
    overrides: Partial<QualifiedExternalSessionHookRuntimeLease> = {},
) {
    const mapHookEvent = vi.fn<AgentExternalSessionHooksContribution['mapHookEvent']>(
        async () => ({
        ok: true as const,
        value: {
            kind: 'mapped' as const,
            sourceInput: source,
            remoteSessionId: 'native-session-1',
            linkData: { projectId: 'project-1' },
            facts: [mappedFact],
        },
        }),
    );
    const hooks: AgentExternalSessionHooksContribution = {
        installationVariants: [installationVariant],
        resolveInstallation: vi.fn(),
        mapHookEvent,
    };
    const resolveSource = vi.fn<BoundedAgentExternalSessionsContribution['resolveSource']>(
        async () => ({
            ok: true as const,
            value: { source },
        }),
    );
    const resolveLinkIdentity = vi.fn<
        BoundedAgentExternalSessionsContribution['resolveLinkIdentity']
    >(async () => ({
        ok: true as const,
        value: {
            source,
            remoteSessionId: 'native-session-1',
            linkData: { projectId: 'project-1' },
        },
    }));
    const retirement = new AbortController();
    return {
        lease: {
            hooks,
            // The ingress consumes an already-bounded leaf façade. Binding the
            // canonical wrapper here would add a second, real-clock deadline
            // authority to cases that drive the ingress on a synthetic clock;
            // the wrapper is exercised against the real leaf in
            // `qualifiedExternalSessionHookDaemonIngress.test.ts`.
            externalSessions: {
                resolveSource,
                resolveLinkIdentity,
                resolveLinkedIdentity: vi.fn(),
                listCandidates: vi.fn(),
                pageTranscript: vi.fn(),
                readAfterTranscript: vi.fn(),
            } satisfies BoundedAgentExternalSessionsContribution,
            generation: 'plugin-generation-1',
            retirementSignal: retirement.signal,
            isCurrent: () => !retirement.signal.aborted,
            release: vi.fn(async () => {}),
            ...overrides,
        } satisfies QualifiedExternalSessionHookRuntimeLease,
        mapHookEvent,
        resolveSource,
        resolveLinkIdentity,
        retirement,
    };
}

function createHarness(input?: Readonly<{
    now?: () => number;
    runtime?: ReturnType<typeof createRuntimeLease>;
    shouldCommit?: () => boolean;
    readAccountScopeKey?: () => string | null;
}>) {
    const runtime = input?.runtime ?? createRuntimeLease();
    type IngressParams = Parameters<
        typeof createQualifiedExternalSessionHookIngress
    >[0];
    const admitFacts = vi.fn<IngressParams['admitFacts']>(async () => {});
    const ensureLink = vi.fn<IngressParams['ensureLink']>(async () => ({
        sessionId: 'happier-session-created',
        created: true,
    }));
    const readAutoLinkPolicy = vi.fn(async (): Promise<Readonly<{
        accountScopeKey: string;
        canonicalResolvedSourceKey: string;
        sourcePolicyId: string;
        enabledAtMs: number;
    }> | null> => null);
    const isAutoLinkPolicyCurrent = vi.fn<
        IngressParams['isAutoLinkPolicyCurrent']
    >(() => true);
    const resolveCurrentLink = vi.fn<IngressParams['resolveCurrentLink']>(
        async () => ({
            sessionId: 'happier-session-1',
            linkGeneration: 'link-generation-1',
        }),
    );
    const acquireRuntime = vi.fn<IngressParams['acquireRuntime']>(
        async () => runtime.lease,
    );
    const ingress = createQualifiedExternalSessionHookIngress({
        acquireRuntime,
        resolveCurrentLink,
        admitFacts,
        readAutoLinkPolicy,
        isAutoLinkPolicyCurrent,
        ensureLink,
        now: input?.now ?? (() => 1_100),
        ...(input?.shouldCommit
            ? { shouldCommit: input.shouldCommit }
            : {}),
        ...(input?.readAccountScopeKey
            ? { readAccountScopeKey: input.readAccountScopeKey }
            : {}),
    });
    const principal = ingress.createPrincipal({
        installationIdentity: 'installation-1',
        machineId: 'machine-1',
        agentId: 'fixture-agent',
        qualifiedContributionId: {
            pluginId: 'happier.agent.fixture',
            localId: 'fixture-agent',
        },
        variantId: 'session-lifecycle-v1',
        eventId: 'session-stop-audit',
        pluginGeneration: 'plugin-generation-1',
        retirementSignal: runtime.retirement.signal,
    });
    expect(ingress.enable(principal.principalRef)).toEqual({ state: 'enabled' });
    return {
        ingress,
        principal,
        runtime,
        acquireRuntime,
        admitFacts,
        ensureLink,
        readAutoLinkPolicy,
        isAutoLinkPolicyCurrent,
        resolveCurrentLink,
    };
}

function delivery(
    token: string,
    overrides: Partial<Parameters<
        ReturnType<typeof createQualifiedExternalSessionHookIngress>['handleAuthenticatedEvent']
    >[0]> = {},
) {
    return {
        token,
        eventId: 'session-stop-audit',
        observedAtMs: 1_000,
        forwardingStartedAtMs: 1_000,
        nativePayload,
        signal: new AbortController().signal,
        ...overrides,
    };
}

afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await Promise.all(
        roots.splice(0).map(async (root) =>
            await rm(root, { recursive: true, force: true })),
    );
});

describe('qualified External Session hook ingress', () => {
    async function createClaudeHarness(
        currentLink: Readonly<{
            sessionId: string;
            linkGeneration: string;
        }> | null,
    ) {
        const configDir = await mkdtemp(
            join(tmpdir(), 'happier-claude-hook-ingress-'),
        );
        roots.push(configDir);
        const remoteSessionId = 'claude-native-session';
        const projectId = 'project-one';
        const projectDir = join(configDir, 'projects', projectId);
        await mkdir(projectDir, { recursive: true });
        await writeFile(
            join(projectDir, `${remoteSessionId}.jsonl`),
            `${JSON.stringify({
                type: 'user',
                sessionId: remoteSessionId,
                uuid: 'message-1',
                timestamp: new Date().toISOString(),
                message: { role: 'user', content: 'fixture' },
            })}\n`,
            'utf8',
        );
        vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
        vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '');

        const activation = await createPluginTestkit({
            manifest: CLAUDE_PLUGIN_MANIFEST,
            module: { activate: activateClaude },
        });
        const registered = activation.registration('agents', 'claude');
        await activation.dispose();
        if (!registered?.externalSessions || !registered.externalSessionHooks) {
            throw new Error(
                'Claude did not register its External Sessions hook vertical',
            );
        }
        const variant =
            registered.externalSessionHooks.installationVariants.find(
                (candidate) => candidate.events.some(
                    (event) => event.nativeEventName === 'Stop',
                ),
            );
        const stopEvent = variant?.events.find(
            (event) => event.nativeEventName === 'Stop',
        );
        if (!variant || !stopEvent) {
            throw new Error('Claude did not register its Stop hook');
        }

        const retirement = new AbortController();
        const runtime: QualifiedExternalSessionHookRuntimeLease = {
            hooks: registered.externalSessionHooks,
            externalSessions: bindFixtureExternalSessions(
                registered.externalSessions,
            ),
            generation: 'claude-generation-1',
            retirementSignal: retirement.signal,
            isCurrent: () => !retirement.signal.aborted,
            async release() {},
        };
        type IngressParams = Parameters<
            typeof createQualifiedExternalSessionHookIngress
        >[0];
        const admitFacts = vi.fn<IngressParams['admitFacts']>(async () => {});
        const ensureLink = vi.fn<IngressParams['ensureLink']>(async () => ({
            sessionId: 'unexpected-created-session',
            created: true,
        }));
        const resolveCurrentLink = vi.fn<
            IngressParams['resolveCurrentLink']
        >(async () => currentLink);
        const readAutoLinkPolicy = vi.fn<
            IngressParams['readAutoLinkPolicy']
        >(async () => null);
        const ingress = createQualifiedExternalSessionHookIngress({
            acquireRuntime: async () => runtime,
            resolveCurrentLink,
            admitFacts,
            readAutoLinkPolicy,
            isAutoLinkPolicyCurrent: () => false,
            ensureLink,
        });
        const principal = ingress.createPrincipal({
            installationIdentity: 'claude-installation-1',
            machineId: 'machine-1',
            agentId: 'claude',
            qualifiedContributionId: {
                pluginId: 'happier.agent.claude',
                localId: 'claude',
            },
            variantId: variant.variantId,
            eventId: stopEvent.eventId,
            pluginGeneration: runtime.generation,
            retirementSignal: retirement.signal,
        });
        expect(ingress.enable(principal.principalRef))
            .toEqual({ state: 'enabled' });

        return {
            ingress,
            principal,
            remoteSessionId,
            projectId,
            stopEventId: stopEvent.eventId,
            admitFacts,
            ensureLink,
            resolveCurrentLink,
            readAutoLinkPolicy,
        };
    }

    function claudeDelivery(
        token: string,
        remoteSessionId: string,
        stopEventId: string,
    ) {
        const forwardingStartedAtMs = Date.now();
        return {
            token,
            eventId: stopEventId,
            observedAtMs: forwardingStartedAtMs,
            forwardingStartedAtMs,
            nativePayload: {
                hook_event_name: 'Stop',
                session_id: remoteSessionId,
                stop_hook_active: false,
            },
            signal: new AbortController().signal,
        } as const;
    }

    it('admits a current Claude hook after link identity refines the resolved source', async () => {
        const harness = await createClaudeHarness({
            sessionId: 'happier-session-1',
            linkGeneration: 'link-generation-1',
        });

        await expect(harness.ingress.handleAuthenticatedEvent(
            claudeDelivery(
                harness.principal.token,
                harness.remoteSessionId,
                harness.stopEventId,
            ),
        )).resolves.toEqual({ state: 'admitted', facts: 1 });

        expect(harness.resolveCurrentLink).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            agentId: 'claude',
            identity: {
                source: {
                    kind: 'claudeConfig',
                    configDir: expect.any(String),
                    projectId: harness.projectId,
                },
                remoteSessionId: harness.remoteSessionId,
                linkData: { projectId: harness.projectId },
                qualifiedIdentity: {
                    v: 1,
                    agent: {
                        pluginId: 'happier.agent.claude',
                        localId: 'claude',
                    },
                    source: {
                        kind: 'claudeConfig',
                        contractVersion: 1,
                    },
                },
            },
        }));
        expect(harness.admitFacts).toHaveBeenCalledOnce();
        expect(harness.ensureLink).not.toHaveBeenCalled();
        expect(harness.readAutoLinkPolicy).not.toHaveBeenCalled();
    });

    it('keeps a valid unlinked Claude hook ignored when auto-link policy is off', async () => {
        const harness = await createClaudeHarness(null);

        await expect(harness.ingress.handleAuthenticatedEvent(
            claudeDelivery(
                harness.principal.token,
                harness.remoteSessionId,
                harness.stopEventId,
            ),
        )).resolves.toEqual({ state: 'ignored' });

        expect(harness.resolveCurrentLink).toHaveBeenCalledOnce();
        expect(harness.readAutoLinkPolicy).toHaveBeenCalledOnce();
        expect(harness.ensureLink).not.toHaveBeenCalled();
        expect(harness.admitFacts).not.toHaveBeenCalled();
    });

    it('rejects a link identity that rewrites the already resolved source', async () => {
        const runtime = createRuntimeLease();
        runtime.resolveLinkIdentity.mockResolvedValue({
            ok: true,
            value: {
                source: {
                    kind: source.kind,
                    scope: 'different-project',
                },
                remoteSessionId: 'native-session-1',
                linkData: { projectId: 'project-1' },
            },
        });
        const harness = createHarness({ runtime });

        await expect(harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token),
        )).resolves.toEqual({ state: 'rejected' });

        expect(harness.resolveCurrentLink).not.toHaveBeenCalled();
        expect(harness.readAutoLinkPolicy).not.toHaveBeenCalled();
        expect(harness.ensureLink).not.toHaveBeenCalled();
        expect(harness.admitFacts).not.toHaveBeenCalled();
    });

    it('routes by the authenticated event id, passes the bounded native payload to the trusted leaf, and admits current facts', async () => {
        const harness = createHarness();

        await expect(
            harness.ingress.handleAuthenticatedEvent(delivery(harness.principal.token)),
        ).resolves.toEqual({ state: 'admitted', facts: 1 });

        expect(harness.acquireRuntime).toHaveBeenCalledWith({
            qualifiedContributionId: {
                pluginId: 'happier.agent.fixture',
                localId: 'fixture-agent',
            },
            agentId: 'fixture-agent',
            pluginGeneration: 'plugin-generation-1',
            variantId: 'session-lifecycle-v1',
        });
        expect(harness.runtime.mapHookEvent).toHaveBeenCalledOnce();
        expect(harness.runtime.mapHookEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                installationIdentity: 'installation-1',
                variantId: 'session-lifecycle-v1',
                eventId: 'session-stop-audit',
                observedAtMs: 1_000,
                nativePayload,
                deadlineAtMs: 1_500,
            }),
        );
        expect(harness.runtime.resolveSource).toHaveBeenCalledTimes(1);
        expect(harness.runtime.resolveLinkIdentity).toHaveBeenCalledWith(
            expect.objectContaining({
                source,
                remoteSessionId: 'native-session-1',
                linkData: { projectId: 'project-1' },
            }),
        );
        expect(harness.admitFacts).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'happier-session-1',
            target: {
                qualifiedLinkIdentity: {
                    v: 1,
                    agent: {
                        pluginId: 'happier.agent.fixture',
                        localId: 'fixture-agent',
                    },
                    source: {
                        kind: 'fixtureSource',
                        contractVersion: 1,
                    },
                },
                linkGeneration: 'link-generation-1',
            },
            facts: [mappedFact],
        }));
        expect(harness.ensureLink).not.toHaveBeenCalled();
        const resolveCurrentInput =
            (harness.resolveCurrentLink.mock.calls as unknown[][])[0]?.[0];
        const admitFactsInput =
            (harness.admitFacts.mock.calls as unknown[][])[0]?.[0];
        expect(admitFactsInput).toEqual(expect.objectContaining({
            shouldCommit: expect.any(Function),
        }));
        expect(
            (admitFactsInput as { shouldCommit(): boolean }).shouldCommit(),
        ).toBe(true);
        expect(resolveCurrentInput).not.toHaveProperty(
            'nativePayload',
        );
        expect(admitFactsInput).not.toHaveProperty(
            'nativePayload',
        );
    });

    it.each([
        {
            label: 'wrong token',
            mutate: () => ({ token: 'wrong-token' }),
        },
        {
            label: 'wrong event id',
            mutate: () => ({ eventId: 'session-stop' }),
        },
        {
            label: 'stale total deadline',
            mutate: () => ({ forwardingStartedAtMs: 599 }),
        },
        {
            label: 'future observation timestamp',
            mutate: () => ({ observedAtMs: 1_101 }),
        },
        {
            label: 'non-JSON native payload',
            mutate: () => ({ nativePayload: { invalid: undefined } as never }),
        },
    ])('rejects $label without invoking the mapper', async ({ mutate }) => {
        const harness = createHarness();

        await expect(harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token, mutate()),
        )).resolves.toEqual({ state: 'rejected' });
        expect(harness.runtime.mapHookEvent).not.toHaveBeenCalled();
        expect(harness.admitFacts).not.toHaveBeenCalled();
        expect(harness.ensureLink).not.toHaveBeenCalled();
    });

    it('keeps principals independent across fully qualified installations, variants, and events', () => {
        const harness = createHarness();
        const unrelated = harness.ingress.createPrincipal({
            installationIdentity: 'installation-1',
            machineId: 'machine-2',
            agentId: 'other-agent',
            qualifiedContributionId: {
                pluginId: 'happier.agent.other',
                localId: 'other-agent',
            },
            variantId: 'session-lifecycle-v2',
            eventId: 'session-stop',
            pluginGeneration: 'plugin-generation-2',
            retirementSignal: new AbortController().signal,
        });

        expect(harness.ingress.readPrincipal(harness.principal.principalRef))
            .toEqual({ state: 'enabled' });
        expect(harness.ingress.readPrincipal(unrelated.principalRef))
            .toEqual({ state: 'disabled' });

        const replacement = harness.ingress.createPrincipal({
            installationIdentity: 'installation-1',
            machineId: 'machine-1',
            agentId: 'fixture-agent',
            qualifiedContributionId: {
                pluginId: 'happier.agent.fixture',
                localId: 'fixture-agent',
            },
            variantId: 'session-lifecycle-v1',
            eventId: 'session-stop-audit',
            pluginGeneration: 'plugin-generation-2',
            retirementSignal: new AbortController().signal,
        });

        expect(harness.ingress.readPrincipal(harness.principal.principalRef))
            .toEqual({ state: 'revoked' });
        expect(harness.ingress.readPrincipal(unrelated.principalRef))
            .toEqual({ state: 'disabled' });
        expect(harness.ingress.readPrincipal(replacement.principalRef))
            .toEqual({ state: 'disabled' });
    });

    it('admits an installed Agent principal addressed by its qualified routing id', () => {
        const harness = createHarness();
        // An installed (non first-party) Agent is routed by its qualified
        // `{pluginId, localId}` key while the principal carries the durable
        // identity, so the two are related by projection, never by equality.
        const installed = harness.ingress.createPrincipal({
            installationIdentity: 'installation-installed',
            machineId: 'machine-1',
            agentId: 'acme.external-sessions/product-agent',
            qualifiedContributionId: {
                pluginId: 'acme.external-sessions',
                localId: 'product-agent',
            },
            variantId: 'session-lifecycle-v1',
            eventId: 'session-stop',
            pluginGeneration: 'plugin-generation-1',
            retirementSignal: new AbortController().signal,
        });
        expect(harness.ingress.readPrincipal(installed.principalRef))
            .toEqual({ state: 'disabled' });

        // A routing id that addresses a different Agent is still refused.
        expect(() => harness.ingress.createPrincipal({
            installationIdentity: 'installation-installed',
            machineId: 'machine-1',
            agentId: 'acme.other-plugin/product-agent',
            qualifiedContributionId: {
                pluginId: 'acme.external-sessions',
                localId: 'product-agent',
            },
            variantId: 'session-lifecycle-v1',
            eventId: 'session-stop',
            pluginGeneration: 'plugin-generation-1',
            retirementSignal: new AbortController().signal,
        })).toThrow(/Invalid qualified External Session hook principal/u);
    });

    it('rehydrates an exact persisted principal reference and token after daemon restart', async () => {
        const runtime = createRuntimeLease();
        const first = createHarness({ runtime });
        const persisted = {
            principalRef: first.principal.principalRef,
            token: first.principal.token,
        };
        first.ingress.revoke(first.principal.principalRef);

        const restarted = createQualifiedExternalSessionHookIngress({
            acquireRuntime: async () => runtime.lease,
            resolveCurrentLink: async () => ({
                sessionId: 'happier-session-1',
                linkGeneration: 'link-generation-1',
            }),
            admitFacts: async () => {},
            readAutoLinkPolicy: async () => null,
            isAutoLinkPolicyCurrent: () => true,
            ensureLink: async () => ({
                sessionId: 'unused',
                created: false,
            }),
            now: () => 1_100,
        });
        const rehydrated = restarted.createPrincipal({
            installationIdentity: 'installation-1',
            machineId: 'machine-1',
            agentId: 'fixture-agent',
            qualifiedContributionId: {
                pluginId: 'happier.agent.fixture',
                localId: 'fixture-agent',
            },
            variantId: 'session-lifecycle-v1',
            eventId: 'session-stop-audit',
            pluginGeneration: 'plugin-generation-1',
            retirementSignal: runtime.retirement.signal,
            principalRef: persisted.principalRef,
            token: persisted.token,
        });

        expect(rehydrated).toEqual(persisted);
        expect(restarted.enable(rehydrated.principalRef)).toEqual({
            state: 'enabled',
        });
        await expect(restarted.handleAuthenticatedEvent(
            delivery(persisted.token),
        )).resolves.toEqual({ state: 'admitted', facts: 1 });
    });

    it('rejects a forwarder timestamp from the future', async () => {
        const harness = createHarness();

        await expect(harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token, {
                forwardingStartedAtMs: 1_101,
            }),
        )).resolves.toEqual({ state: 'rejected' });
        expect(harness.runtime.mapHookEvent).not.toHaveBeenCalled();
    });

    it('uses only the single total deadline and rejects a late mapper result', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const harness = createHarness({ now: Date.now });
        let settleLate!: (
            value: Awaited<ReturnType<typeof harness.runtime.mapHookEvent>>,
        ) => void;
        harness.runtime.mapHookEvent.mockImplementationOnce(
            async () => await new Promise((resolve) => {
                settleLate = resolve;
            }),
        );

        const pending = harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.runtime.mapHookEvent).toHaveBeenCalledOnce();
        const mapperRequest = harness.runtime.mapHookEvent.mock.calls[0]?.[0];
        expect(mapperRequest?.deadlineAtMs).toBe(1_500);

        await vi.advanceTimersByTimeAsync(500);
        await expect(pending).resolves.toEqual({ state: 'rejected' });
        expect(mapperRequest?.signal.aborted).toBe(true);

        settleLate({
            ok: true,
            value: {
                kind: 'mapped',
                sourceInput: source,
                remoteSessionId: 'native-session-1',
                facts: [mappedFact],
            },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.runtime.resolveSource).not.toHaveBeenCalled();
        expect(harness.admitFacts).not.toHaveBeenCalled();
        expect(harness.ensureLink).not.toHaveBeenCalled();
    });

    it('aborts and fences an in-flight event when its generation retires', async () => {
        const harness = createHarness();
        let settleLate!: (
            value: Awaited<ReturnType<typeof harness.runtime.mapHookEvent>>,
        ) => void;
        harness.runtime.mapHookEvent.mockImplementationOnce(
            async () => await new Promise((resolve) => {
                settleLate = resolve;
            }),
        );

        const pending = harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token),
        );
        await vi.waitFor(() => {
            expect(harness.runtime.mapHookEvent).toHaveBeenCalledOnce();
        });
        const mapperSignal =
            harness.runtime.mapHookEvent.mock.calls[0]?.[0]?.signal;
        harness.runtime.retirement.abort();

        await expect(pending).resolves.toEqual({ state: 'rejected' });
        expect(mapperSignal?.aborted).toBe(true);
        expect(harness.ingress.readPrincipal(harness.principal.principalRef))
            .toEqual({ state: 'generation_retired' });

        settleLate({
            ok: true,
            value: {
                kind: 'mapped',
                sourceInput: source,
                remoteSessionId: 'native-session-1',
                facts: [mappedFact],
            },
        });
        await Promise.resolve();
        expect(harness.admitFacts).not.toHaveBeenCalled();
        expect(harness.ensureLink).not.toHaveBeenCalled();
        expect(harness.runtime.lease.release).toHaveBeenCalledOnce();
    });

    it('publishes no facts when the host listener stops before the serialized admission commit', async () => {
        let hostCurrent = true;
        const harness = createHarness({
            shouldCommit: () => hostCurrent,
        });
        let releaseCommit!: () => void;
        const publishedFacts: unknown[] = [];
        harness.admitFacts.mockImplementationOnce(
            async (input: Readonly<{
                facts: readonly unknown[];
                shouldCommit?: () => boolean;
            }>) => {
                await new Promise<void>((resolve) => {
                    releaseCommit = resolve;
                });
                if (input.shouldCommit?.() !== false) {
                    publishedFacts.push(...input.facts);
                }
            },
        );

        const pending = harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token),
        );
        await vi.waitFor(() => {
            expect(harness.admitFacts).toHaveBeenCalledOnce();
        });
        hostCurrent = false;
        releaseCommit();

        await expect(pending).resolves.toEqual({ state: 'rejected' });
        expect(publishedFacts).toEqual([]);
        expect(harness.ensureLink).not.toHaveBeenCalled();
    });

    it('creates no link when the feature disables before the session-creation commit', async () => {
        let hostCurrent = true;
        const harness = createHarness({
            shouldCommit: () => hostCurrent,
        });
        harness.resolveCurrentLink.mockResolvedValue(null);
        harness.readAutoLinkPolicy.mockResolvedValue({
            accountScopeKey: 'account-scope-1',
            canonicalResolvedSourceKey: 'fixtureSource:project-1',
            enabledAtMs: 900,
            sourcePolicyId: 'es-source-policy:v1:opaque',
        });
        let releaseCommit!: () => void;
        const createdSessionIds: string[] = [];
        harness.ensureLink.mockImplementationOnce(
            async (input: Readonly<{
                shouldCommit?: () => boolean;
            }>) => {
                await new Promise<void>((resolve) => {
                    releaseCommit = resolve;
                });
                if (input.shouldCommit?.() === false) {
                    throw new Error('Session creation commit precondition failed');
                }
                createdSessionIds.push('happier-session-created');
                return {
                    sessionId: 'happier-session-created',
                    created: true,
                };
            },
        );

        const pending = harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token),
        );
        await vi.waitFor(() => {
            expect(harness.ensureLink).toHaveBeenCalledOnce();
        });
        hostCurrent = false;
        releaseCommit();

        await expect(pending).resolves.toEqual({ state: 'rejected' });
        expect(createdSessionIds).toEqual([]);
        expect(harness.admitFacts).not.toHaveBeenCalled();
    });

    it('creates no link when the exact auto-link policy changes before the session-creation commit', async () => {
        const harness = createHarness();
        harness.resolveCurrentLink.mockResolvedValue(null);
        harness.readAutoLinkPolicy.mockResolvedValue({
            accountScopeKey: 'account-scope-1',
            canonicalResolvedSourceKey: 'fixtureSource:project-1',
            enabledAtMs: 900,
            sourcePolicyId: 'es-source-policy:v1:opaque',
        });
        let currentEnabledAtMs = 900;
        harness.isAutoLinkPolicyCurrent.mockImplementation((input) => (
            input.machineId === 'machine-1'
            && input.sourcePolicyId === 'es-source-policy:v1:opaque'
            && input.enabledAtMs === currentEnabledAtMs
        ));
        let releaseCommit!: () => void;
        const createdSessionIds: string[] = [];
        harness.ensureLink.mockImplementationOnce(async (input) => {
            await new Promise<void>((resolve) => {
                releaseCommit = resolve;
            });
            if (input.shouldCommit?.() === false) {
                throw new Error('Session creation commit precondition failed');
            }
            createdSessionIds.push('happier-session-created');
            return {
                sessionId: 'happier-session-created',
                created: true,
            };
        });

        const pending = harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token),
        );
        await vi.waitFor(() => {
            expect(harness.ensureLink).toHaveBeenCalledOnce();
        });
        currentEnabledAtMs = 901;
        releaseCommit();

        await expect(pending).resolves.toEqual({ state: 'rejected' });
        expect(createdSessionIds).toEqual([]);
        expect(harness.isAutoLinkPolicyCurrent).toHaveBeenCalledWith({
            machineId: 'machine-1',
            qualifiedIdentity: {
                agent: {
                    pluginId: 'happier.agent.fixture',
                    localId: 'fixture-agent',
                },
                source: {
                    contractVersion: 1,
                    kind: 'fixtureSource',
                },
                v: 1,
            },
            sourcePolicyId: 'es-source-policy:v1:opaque',
            enabledAtMs: 900,
            accountScopeKey: 'account-scope-1',
        });
    });

    it('fences an account switch while hook identity resolution is awaiting', async () => {
        let accountScopeKey = 'account-scope-a';
        let linked = false;
        const harness = createHarness({
            readAccountScopeKey: () => accountScopeKey,
        });
        harness.resolveCurrentLink.mockImplementation(async () => (
            linked
                ? {
                    sessionId: 'happier-session-b',
                    linkGeneration: 'link-generation-b',
                }
                : null
        ));
        harness.ensureLink.mockImplementation(async () => {
            linked = true;
            return {
                sessionId: 'happier-session-b',
                created: true,
            };
        });
        harness.readAutoLinkPolicy.mockImplementation(async () => ({
            accountScopeKey,
            canonicalResolvedSourceKey: 'fixtureSource:project-1',
            enabledAtMs: 900,
            sourcePolicyId: `es-source-policy:v1:${accountScopeKey}`,
        }));
        let releaseSourceResolution!: () => void;
        harness.runtime.resolveSource.mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => {
                releaseSourceResolution = resolve;
            });
            return {
                ok: true,
                value: { source },
            };
        });

        const pending = harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token),
        );
        await vi.waitFor(() => {
            expect(harness.runtime.resolveSource).toHaveBeenCalledOnce();
        });
        accountScopeKey = 'account-scope-b';
        releaseSourceResolution();

        await expect(pending).resolves.toEqual({ state: 'rejected' });
        expect(harness.readAutoLinkPolicy).not.toHaveBeenCalled();
        expect(harness.ensureLink).not.toHaveBeenCalled();
        expect(harness.admitFacts).not.toHaveBeenCalled();

        await expect(harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token),
        )).resolves.toEqual({ state: 'admitted', facts: 1 });
        expect(harness.runtime.resolveSource).toHaveBeenCalledTimes(2);
        expect(harness.runtime.resolveLinkIdentity).toHaveBeenCalledOnce();
        expect(harness.runtime.resolveLinkIdentity).toHaveBeenCalledWith(
            expect.objectContaining({
                source,
                remoteSessionId: 'native-session-1',
            }),
        );
        expect(harness.readAutoLinkPolicy).toHaveBeenCalledWith(
            expect.objectContaining({
                source,
                qualifiedIdentity: expect.objectContaining({
                    agent: {
                        pluginId: 'happier.agent.fixture',
                        localId: 'fixture-agent',
                    },
                }),
            }),
        );
        expect(harness.ensureLink).toHaveBeenCalledOnce();
        expect(harness.admitFacts).toHaveBeenCalledOnce();
    });

    it.each([
        { label: 'account switch', nextScope: 'account-scope-b' },
        { label: 'logout', nextScope: null },
    ])(
        'fences $label before the canonical link-creation commit',
        async ({ nextScope }) => {
            let accountScopeKey: string | null = 'account-scope-a';
            const harness = createHarness({
                readAccountScopeKey: () => accountScopeKey,
            });
            harness.resolveCurrentLink.mockResolvedValue(null);
            harness.readAutoLinkPolicy.mockResolvedValue({
                accountScopeKey: 'account-scope-a',
                canonicalResolvedSourceKey: 'fixtureSource:project-1',
                enabledAtMs: 900,
                sourcePolicyId: 'es-source-policy:v1:opaque',
            });
            let releaseCommit!: () => void;
            const createdSessionIds: string[] = [];
            harness.ensureLink.mockImplementationOnce(async (input) => {
                await new Promise<void>((resolve) => {
                    releaseCommit = resolve;
                });
                if (!input.shouldCommit?.()) {
                    throw new Error('Session creation commit precondition failed');
                }
                createdSessionIds.push('happier-session-created');
                return {
                    sessionId: 'happier-session-created',
                    created: true,
                };
            });

            const pending = harness.ingress.handleAuthenticatedEvent(
                delivery(harness.principal.token),
            );
            await vi.waitFor(() => {
                expect(harness.ensureLink).toHaveBeenCalledOnce();
            });
            accountScopeKey = nextScope;
            releaseCommit();

            await expect(pending).resolves.toEqual({ state: 'rejected' });
            expect(createdSessionIds).toEqual([]);
            expect(harness.admitFacts).not.toHaveBeenCalled();
        },
    );

    it.each(['disable', 'revoke'] as const)(
        '%s aborts an in-flight principal before it can admit effects',
        async (terminalAction) => {
            const harness = createHarness();
            let resolveCurrent!: (
                value: Awaited<ReturnType<typeof harness.resolveCurrentLink>>,
            ) => void;
            harness.resolveCurrentLink.mockImplementationOnce(
                async () => await new Promise((resolve) => {
                    resolveCurrent = resolve;
                }),
            );

            const pending = harness.ingress.handleAuthenticatedEvent(
                delivery(harness.principal.token),
            );
            await vi.waitFor(() => {
                expect(harness.resolveCurrentLink).toHaveBeenCalledOnce();
            });
            harness.ingress[terminalAction](harness.principal.principalRef);
            resolveCurrent({
                sessionId: 'happier-session-1',
                linkGeneration: 'link-generation-1',
            });

            await expect(pending).resolves.toEqual({ state: 'rejected' });
            expect(harness.admitFacts).not.toHaveBeenCalled();
            expect(harness.ensureLink).not.toHaveBeenCalled();
        },
    );

    it('releases a runtime that arrives after the event is cancelled', async () => {
        const runtime = createRuntimeLease();
        let resolveRuntime!: (
            value: QualifiedExternalSessionHookRuntimeLease | null,
        ) => void;
        const acquireRuntime = vi.fn(
            async () => await new Promise<QualifiedExternalSessionHookRuntimeLease | null>(
                (resolve) => {
                    resolveRuntime = resolve;
                },
            ),
        );
        const ingress = createQualifiedExternalSessionHookIngress({
            acquireRuntime,
            resolveCurrentLink: vi.fn(),
            admitFacts: vi.fn(),
            readAutoLinkPolicy: vi.fn(),
            isAutoLinkPolicyCurrent: vi.fn(),
            ensureLink: vi.fn(),
            now: () => 1_100,
        });
        const principal = ingress.createPrincipal({
            installationIdentity: 'installation-1',
            machineId: 'machine-1',
            agentId: 'fixture-agent',
            qualifiedContributionId: {
                pluginId: 'happier.agent.fixture',
                localId: 'fixture-agent',
            },
            variantId: 'session-lifecycle-v1',
            eventId: 'session-stop-audit',
            pluginGeneration: 'plugin-generation-1',
            retirementSignal: runtime.retirement.signal,
        });
        ingress.enable(principal.principalRef);
        const cancellation = new AbortController();

        const pending = ingress.handleAuthenticatedEvent(delivery(
            principal.token,
            { signal: cancellation.signal },
        ));
        await vi.waitFor(() => expect(acquireRuntime).toHaveBeenCalledOnce());
        cancellation.abort();
        await expect(pending).resolves.toEqual({ state: 'rejected' });

        resolveRuntime(runtime.lease);
        await vi.waitFor(() => {
            expect(runtime.lease.release).toHaveBeenCalledOnce();
        });
        expect(runtime.mapHookEvent).not.toHaveBeenCalled();
    });

    it('uses the canonical result validator before resolving identity', async () => {
        const harness = createHarness();
        harness.runtime.mapHookEvent.mockResolvedValueOnce({
            ok: true,
            value: {
                kind: 'mapped',
                sourceInput: source,
                remoteSessionId: 'native-session-1',
                facts: [{
                    ...mappedFact,
                    evidenceClass: 'observer',
                }],
            },
        } as never);

        await expect(harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token),
        )).resolves.toEqual({ state: 'rejected' });
        expect(harness.runtime.resolveSource).not.toHaveBeenCalled();
        expect(harness.admitFacts).not.toHaveBeenCalled();
        expect(harness.ensureLink).not.toHaveBeenCalled();
    });

    it('keeps no-link behavior default-off and invokes only the existing eligible policy sink', async () => {
        const harness = createHarness();
        let ensured = false;
        const indexedTagLookupProof = {
            state: 'available' as const,
            tags: ['direct:v1:fixture'],
            sessions: [],
        };
        harness.resolveCurrentLink.mockImplementation(async () => (
            ensured
                ? {
                    state: 'linked' as const,
                    sessionId: 'happier-session-created',
                    linkGeneration: 'link-generation-created',
                }
                : {
                    state: 'absent' as const,
                    indexedTagLookupProof,
                }
        ));
        harness.ensureLink.mockImplementationOnce(async () => {
            ensured = true;
            return {
                sessionId: 'happier-session-created',
                created: true,
            };
        });
        harness.runtime.mapHookEvent.mockResolvedValue({
            ok: true,
            value: {
                kind: 'mapped',
                sourceInput: source,
                remoteSessionId: 'native-session-1',
                createdAtMs: 1_000,
                facts: [],
            },
        });

        await expect(harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token),
        )).resolves.toEqual({ state: 'ignored' });
        expect(harness.ensureLink).not.toHaveBeenCalled();

        harness.readAutoLinkPolicy.mockResolvedValue({
            accountScopeKey: 'account-scope-1',
            canonicalResolvedSourceKey: 'fixtureSource:project-1',
            enabledAtMs: 900,
            sourcePolicyId: 'es-source-policy:v1:opaque',
        });
        await expect(harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token),
        )).resolves.toEqual({ state: 'admitted', facts: 0 });
        expect(harness.ensureLink).toHaveBeenCalledOnce();
        expect(harness.ensureLink).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            agentId: 'fixture-agent',
            expectedSourceKey: 'fixtureSource:project-1',
            source,
            remoteSessionId: 'native-session-1',
            storageMode: 'machine_only',
            indexedTagLookupProof,
            signal: expect.any(AbortSignal),
            deadlineAtMs: 1_500,
            shouldCommit: expect.any(Function),
        }));
        expect(harness.admitFacts).not.toHaveBeenCalled();
    });

    it('fails closed before auto-link when indexed lookup is unavailable or ambiguous', async () => {
        const harness = createHarness();
        harness.resolveCurrentLink.mockResolvedValue({
            state: 'blocked',
        });
        harness.readAutoLinkPolicy.mockResolvedValue({
            accountScopeKey: 'account-scope-1',
            canonicalResolvedSourceKey: 'fixtureSource:project-1',
            enabledAtMs: 900,
            sourcePolicyId: 'es-source-policy:v1:opaque',
        });

        await expect(harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token),
        )).resolves.toEqual({ state: 'ignored' });

        expect(harness.resolveCurrentLink).toHaveBeenCalledOnce();
        expect(harness.readAutoLinkPolicy).not.toHaveBeenCalled();
        expect(harness.ensureLink).not.toHaveBeenCalled();
        expect(harness.admitFacts).not.toHaveBeenCalled();
    });

    it('returns to current-link fact admission when the atomic ensure observes a concurrent manual winner', async () => {
        const harness = createHarness();
        harness.resolveCurrentLink
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                sessionId: 'happier-session-manual-winner',
                linkGeneration: 'link-generation-manual-winner',
            });
        harness.readAutoLinkPolicy.mockResolvedValue({
            accountScopeKey: 'account-scope-1',
            canonicalResolvedSourceKey: 'fixtureSource:project-1',
            enabledAtMs: 900,
            sourcePolicyId: 'es-source-policy:v1:opaque',
        });

        await expect(harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token),
        )).resolves.toEqual({ state: 'admitted', facts: 1 });

        expect(harness.resolveCurrentLink).toHaveBeenCalledTimes(2);
        expect(harness.ensureLink).toHaveBeenCalledOnce();
        expect(harness.admitFacts).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'happier-session-manual-winner',
            target: {
                qualifiedLinkIdentity: {
                    agent: {
                        pluginId: 'happier.agent.fixture',
                        localId: 'fixture-agent',
                    },
                    source: {
                        contractVersion: 1,
                        kind: 'fixtureSource',
                    },
                    v: 1,
                },
                linkGeneration: 'link-generation-manual-winner',
            },
            facts: [mappedFact],
            shouldCommit: expect.any(Function),
        }));
    });

    it('coalesces concurrent duplicate observations on one canonical link ensure', async () => {
        const harness = createHarness();
        let ensureSettled = false;
        harness.resolveCurrentLink.mockImplementation(async () => (
            ensureSettled
                ? {
                    sessionId: 'happier-session-created',
                    linkGeneration: 'link-generation-created',
                }
                : null
        ));
        harness.readAutoLinkPolicy.mockResolvedValue({
            accountScopeKey: 'account-scope-1',
            canonicalResolvedSourceKey: 'fixtureSource:project-1',
            enabledAtMs: 900,
            sourcePolicyId: 'es-source-policy:v1:opaque',
        });
        let settleEnsure!: (value: Readonly<{
            sessionId: string;
            created: boolean;
        }>) => void;
        harness.ensureLink.mockImplementationOnce(
            async () => await new Promise((resolve) => {
                settleEnsure = resolve;
            }),
        );

        const first = harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token),
        );
        const duplicate = harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token),
        );
        await vi.waitFor(() => expect(harness.ensureLink).toHaveBeenCalledOnce());
        ensureSettled = true;
        settleEnsure({
            sessionId: 'happier-session-created',
            created: true,
        });

        await expect(Promise.all([first, duplicate])).resolves.toEqual([
            { state: 'admitted', facts: 1 },
            { state: 'admitted', facts: 1 },
        ]);
        expect(harness.ensureLink).toHaveBeenCalledOnce();
        expect(harness.admitFacts).toHaveBeenCalledTimes(2);
        expect(harness.admitFacts).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'happier-session-created',
            target: {
                qualifiedLinkIdentity: {
                    agent: {
                        pluginId: 'happier.agent.fixture',
                        localId: 'fixture-agent',
                    },
                    source: {
                        contractVersion: 1,
                        kind: 'fixtureSource',
                    },
                    v: 1,
                },
                linkGeneration: 'link-generation-created',
            },
            facts: [mappedFact],
            shouldCommit: expect.any(Function),
        }));
    });

    it('coalesces same-generation installation variants that resolve to one canonical identity', async () => {
        const harness = createHarness();
        let ensureSettled = false;
        harness.resolveCurrentLink.mockImplementation(async () => (
            ensureSettled
                ? {
                    sessionId: 'happier-session-created',
                    linkGeneration: 'link-generation-created',
                }
                : null
        ));
        harness.readAutoLinkPolicy.mockResolvedValue({
            accountScopeKey: 'account-scope-1',
            canonicalResolvedSourceKey: 'fixtureSource:project-1',
            enabledAtMs: 900,
            sourcePolicyId: 'es-source-policy:v1:opaque',
        });
        let settleEnsure!: (value: Readonly<{
            sessionId: string;
            created: boolean;
        }>) => void;
        harness.ensureLink.mockImplementationOnce(
            async () => await new Promise((resolve) => {
                settleEnsure = resolve;
            }),
        );
        const secondInstallation = harness.ingress.createPrincipal({
            installationIdentity: 'installation-2',
            machineId: 'machine-1',
            agentId: 'fixture-agent',
            qualifiedContributionId: {
                pluginId: 'happier.agent.fixture',
                localId: 'fixture-agent',
            },
            variantId: 'session-lifecycle-v1',
            eventId: 'session-stop-audit',
            pluginGeneration: 'plugin-generation-1',
            retirementSignal: harness.runtime.retirement.signal,
        });
        harness.ingress.enable(secondInstallation.principalRef);

        const first = harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token),
        );
        const duplicateInstallation = harness.ingress.handleAuthenticatedEvent(
            delivery(secondInstallation.token),
        );
        await vi.waitFor(() => expect(harness.ensureLink).toHaveBeenCalledOnce());
        ensureSettled = true;
        settleEnsure({
            sessionId: 'happier-session-created',
            created: true,
        });

        await expect(Promise.all([first, duplicateInstallation])).resolves.toEqual([
            { state: 'admitted', facts: 1 },
            { state: 'admitted', facts: 1 },
        ]);
        expect(harness.ensureLink).toHaveBeenCalledOnce();
        expect(harness.admitFacts).toHaveBeenCalledTimes(2);
    });

    it('keeps a coalesced current installation eligible when the first installation disables before ensure commit', async () => {
        const harness = createHarness();
        let ensureSettled = false;
        harness.resolveCurrentLink.mockImplementation(async () => (
            ensureSettled
                ? {
                    sessionId: 'happier-session-created',
                    linkGeneration: 'link-generation-created',
                }
                : null
        ));
        harness.readAutoLinkPolicy.mockResolvedValue({
            accountScopeKey: 'account-scope-1',
            canonicalResolvedSourceKey: 'fixtureSource:project-1',
            enabledAtMs: 900,
            sourcePolicyId: 'es-source-policy:v1:opaque',
        });
        let releaseEnsureCommit!: () => void;
        harness.ensureLink.mockImplementationOnce(
            async (input) => {
                await Promise.race([
                    new Promise<void>((resolve) => {
                        releaseEnsureCommit = resolve;
                    }),
                    new Promise<never>((_, reject) => {
                        input.signal.addEventListener(
                            'abort',
                            () => reject(new Error('Shared ensure was aborted')),
                            { once: true },
                        );
                    }),
                ]);
                if (!input.shouldCommit?.()) {
                    throw new Error('Session creation commit precondition failed');
                }
                ensureSettled = true;
                return {
                    sessionId: 'happier-session-created',
                    created: true,
                };
            },
        );
        const secondInstallation = harness.ingress.createPrincipal({
            installationIdentity: 'installation-2',
            machineId: 'machine-1',
            agentId: 'fixture-agent',
            qualifiedContributionId: {
                pluginId: 'happier.agent.fixture',
                localId: 'fixture-agent',
            },
            variantId: 'session-lifecycle-v1',
            eventId: 'session-stop-audit',
            pluginGeneration: 'plugin-generation-1',
            retirementSignal: harness.runtime.retirement.signal,
        });
        harness.ingress.enable(secondInstallation.principalRef);

        const first = harness.ingress.handleAuthenticatedEvent(
            delivery(harness.principal.token),
        );
        await vi.waitFor(() => expect(harness.ensureLink).toHaveBeenCalledOnce());
        const second = harness.ingress.handleAuthenticatedEvent(
            delivery(secondInstallation.token),
        );
        await vi.waitFor(() => {
            expect(harness.runtime.mapHookEvent).toHaveBeenCalledTimes(2);
        });

        expect(harness.ingress.disable(harness.principal.principalRef))
            .toEqual({ state: 'disabled' });
        releaseEnsureCommit();

        await expect(first).resolves.toEqual({ state: 'rejected' });
        await expect(second).resolves.toEqual({
            state: 'admitted',
            facts: 1,
        });
        expect(harness.ensureLink).toHaveBeenCalledOnce();
        expect(harness.admitFacts).toHaveBeenCalledOnce();
    });

    it('fails closed with a bounded result when the current runtime is unavailable or canonical ensure fails', async () => {
        const unavailable = createHarness();
        unavailable.acquireRuntime.mockResolvedValueOnce(null);

        await expect(unavailable.ingress.handleAuthenticatedEvent(
            delivery(unavailable.principal.token),
        )).resolves.toEqual({ state: 'rejected' });
        expect(unavailable.runtime.mapHookEvent).not.toHaveBeenCalled();
        expect(unavailable.admitFacts).not.toHaveBeenCalled();
        expect(unavailable.ensureLink).not.toHaveBeenCalled();

        const ensureFailure = createHarness();
        ensureFailure.resolveCurrentLink.mockResolvedValue(null);
        ensureFailure.readAutoLinkPolicy.mockResolvedValue({
            accountScopeKey: 'account-scope-1',
            canonicalResolvedSourceKey: 'fixtureSource:project-1',
            enabledAtMs: 900,
            sourcePolicyId: 'es-source-policy:v1:opaque',
        });
        ensureFailure.ensureLink.mockRejectedValueOnce(
            new Error('canonical ensure unavailable'),
        );

        await expect(ensureFailure.ingress.handleAuthenticatedEvent(
            delivery(ensureFailure.principal.token),
        )).resolves.toEqual({ state: 'rejected' });
        expect(ensureFailure.ensureLink).toHaveBeenCalledOnce();
        expect(ensureFailure.admitFacts).not.toHaveBeenCalled();
    });

    it('does not share an in-flight link ensure across principal generations and source policies', async () => {
        const firstRuntime = createRuntimeLease();
        const secondRuntime = createRuntimeLease({
            generation: 'plugin-generation-2',
        });
        let settleFirstEnsure!: (value: Readonly<{
            sessionId: string;
            created: boolean;
        }>) => void;
        let currentLink: Readonly<{
            sessionId: string;
            linkGeneration: string;
        }> | null = null;
        const ensureLink = vi.fn(async () => {
            currentLink = {
                sessionId: 'happier-session-generation-2',
                linkGeneration: 'link-generation-2',
            };
            return {
                sessionId: 'happier-session-generation-2',
                created: true,
            };
        });
        ensureLink.mockImplementationOnce(
            async () => await new Promise((resolve) => {
                settleFirstEnsure = resolve;
            }),
        );
        const readAutoLinkPolicy = vi.fn()
            .mockResolvedValueOnce({
                accountScopeKey: 'account-scope-1',
                canonicalResolvedSourceKey: 'fixtureSource:project-1',
                enabledAtMs: 900,
                sourcePolicyId: 'source-policy-generation-1',
            })
            .mockResolvedValueOnce({
                accountScopeKey: 'account-scope-1',
                canonicalResolvedSourceKey: 'fixtureSource:project-1',
                enabledAtMs: 900,
                sourcePolicyId: 'source-policy-generation-2',
            });
        const ingress = createQualifiedExternalSessionHookIngress({
            acquireRuntime: async (request) => (
                request.pluginGeneration === 'plugin-generation-1'
                    ? firstRuntime.lease
                    : secondRuntime.lease
            ),
            resolveCurrentLink: async () => currentLink,
            admitFacts: async () => {},
            readAutoLinkPolicy,
            isAutoLinkPolicyCurrent: () => true,
            ensureLink,
            now: () => 1_100,
        });
        const createPrincipal = (
            pluginGeneration: string,
            retirementSignal: AbortSignal,
        ) => ingress.createPrincipal({
            installationIdentity: 'installation-1',
            machineId: 'machine-1',
            agentId: 'fixture-agent',
            qualifiedContributionId: {
                pluginId: 'happier.agent.fixture',
                localId: 'fixture-agent',
            },
            variantId: 'session-lifecycle-v1',
            eventId: 'session-stop-audit',
            pluginGeneration,
            retirementSignal,
        });
        const firstPrincipal = createPrincipal(
            'plugin-generation-1',
            firstRuntime.retirement.signal,
        );
        ingress.enable(firstPrincipal.principalRef);
        const firstPending = ingress.handleAuthenticatedEvent(
            delivery(firstPrincipal.token),
        );
        await vi.waitFor(() => expect(ensureLink).toHaveBeenCalledOnce());

        const secondPrincipal = createPrincipal(
            'plugin-generation-2',
            secondRuntime.retirement.signal,
        );
        ingress.enable(secondPrincipal.principalRef);
        const secondPending = ingress.handleAuthenticatedEvent(
            delivery(secondPrincipal.token),
        );
        await vi.waitFor(() => {
            expect(readAutoLinkPolicy).toHaveBeenCalledTimes(2);
        });
        const ensureCallsBeforeFirstSettles = ensureLink.mock.calls.length;
        settleFirstEnsure({
            sessionId: 'happier-session-generation-1',
            created: true,
        });

        await expect(firstPending).resolves.toEqual({ state: 'rejected' });
        await expect(secondPending).resolves.toEqual({
            state: 'admitted',
            facts: 1,
        });
        expect(ensureCallsBeforeFirstSettles).toBe(2);
        expect(ensureLink).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                sourcePolicyId: 'source-policy-generation-2',
            }),
        );
    });
});
