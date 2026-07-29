import { describe, expect, it, vi } from 'vitest';

import type {
    AgentExternalSessionHooksContribution,
    AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import {
    createExternalSessionObservationProjection,
} from '@/api/session/external/leases/createExternalSessionObservationProjection';
import {
    createExternalSessionObservationReconciler,
} from '@/api/session/external/leases/createExternalSessionObservationReconciler';

import { createQualifiedExternalSessionHookDaemonIngress } from './qualifiedExternalSessionHookDaemonIngress';

type ResolveDurableCurrentLink = NonNullable<
    Parameters<typeof createQualifiedExternalSessionHookDaemonIngress>[0]['resolveDurableCurrentLink']
>;

const qualifiedIdentity = {
    v: 1 as const,
    agent: {
        pluginId: 'happier.agent.fixture',
        localId: 'fixture',
    },
    source: {
        kind: 'fixture.source',
        contractVersion: 1 as const,
    },
} as const;

const source = {
    kind: 'fixture.source',
    scope: 'workspace-1',
} as const;

function durableLink(linkGeneration = '1') {
    return {
        resource: {
            pluginId: qualifiedIdentity.agent.pluginId,
            agentLocalId: qualifiedIdentity.agent.localId,
            pluginGeneration: 'plugin-generation-1',
            resourceKey: 'fixture-resource',
        },
        link: {
            sessionId: 'session-1',
            linkGeneration,
            linkKey: 'native-session-1',
            linkedSource: {
                source,
                remoteSessionId: 'native-session-1',
                linkData: { scope: 'workspace-1' },
            },
            changeObservation: 'reconcile_only' as const,
        },
        target: {
            qualifiedLinkIdentity: qualifiedIdentity,
            linkGeneration,
        },
    } as const;
}

function runtime(nowMs: number) {
    const hooks: AgentExternalSessionHooksContribution = {
        installationVariants: [{
            variantId: 'fixture-hooks-v1',
            targets: [{
                targetId: 'settings',
                format: 'hook_event_json_arrays_v1',
                collectionId: 'hooks',
            }],
            events: [{
                eventId: 'session-stop',
                targetId: 'settings',
                nativeEventName: 'Stop',
                command: {
                    kind: 'happier_observation_v1',
                    shellDialect: 'posix',
                },
            }],
        }],
        resolveInstallation: vi.fn(),
        mapHookEvent: vi.fn(async () => ({
            ok: true as const,
            value: {
                kind: 'mapped' as const,
                sourceInput: source,
                remoteSessionId: 'native-session-1',
                linkData: { scope: 'workspace-1' },
                facts: [{
                    kind: 'turn_phase' as const,
                    value: 'idle' as const,
                    evidenceClass: 'qualified_hook' as const,
                    observedAtMs: nowMs,
                    expiresAtMs: nowMs + 1_000,
                }],
            },
        })),
    };
    const externalSessions: AgentExternalSessionsContribution = {
        resolveSource: vi.fn(async () => ({
            ok: true as const,
            value: { source },
        })),
        resolveLinkIdentity: vi.fn(async () => ({
            ok: true as const,
            value: {
                source,
                remoteSessionId: 'native-session-1',
                linkData: { scope: 'workspace-1' },
            },
        })),
        resolveLinkedIdentity: vi.fn(),
        listCandidates: vi.fn(),
        pageTranscript: vi.fn(),
        readAfterTranscript: vi.fn(),
    };
    const retirement = new AbortController();
    return {
        hooks,
        externalSessions,
        generation: 'plugin-generation-1',
        retirementSignal: retirement.signal,
        isCurrent: () => true,
        release: vi.fn(async () => undefined),
    };
}

function setup(resolveDurableCurrentLink: ReturnType<typeof vi.fn>) {
    const nowMs = Date.now();
    const acquireObserver = vi.fn();
    const requestTranscriptRefresh = vi.fn();
    const reconciler = createExternalSessionObservationReconciler({
        acquireObserver,
        requestTranscriptRefresh,
    });
    const publishField = vi.fn(async () => undefined);
    const projection = createExternalSessionObservationProjection({
        reconciler,
        publishField,
        now: () => nowMs,
    });
    const ingress = createQualifiedExternalSessionHookDaemonIngress({
        machineId: 'machine-1',
        projection,
        isFeatureEnabled: () => true,
        readAccountScopeKey: () => 'account-scope-1',
        resolveDurableCurrentLink,
        acquireRuntime: async () => runtime(nowMs),
    });
    const principal = ingress.createPrincipal({
        installationIdentity: 'installation-1',
        machineId: 'machine-1',
        agentId: 'fixture',
        qualifiedContributionId: qualifiedIdentity.agent,
        variantId: 'fixture-hooks-v1',
        eventId: 'session-stop',
        pluginGeneration: 'plugin-generation-1',
        retirementSignal: new AbortController().signal,
    });
    ingress.enable(principal.principalRef);
    return {
        ingress,
        principal,
        projection,
        publishField,
        acquireObserver,
        requestTranscriptRefresh,
        nowMs,
    };
}

describe('qualified External Session hook daemon ingress', () => {
    it('publishes an already-linked hook fact with no observation or transcript demand', async () => {
        const resolveDurableCurrentLink = vi.fn<ResolveDurableCurrentLink>(
            async () => durableLink(),
        );
        const owner = setup(resolveDurableCurrentLink);

        await expect(owner.ingress.handleAuthenticatedEvent({
            token: owner.principal.token,
            eventId: 'session-stop',
            observedAtMs: owner.nowMs,
            forwardingStartedAtMs: owner.nowMs,
            nativePayload: { session_id: 'native-session-1' },
            signal: new AbortController().signal,
        })).resolves.toEqual({ state: 'admitted', facts: 1 });
        await owner.projection.flush();

        expect(resolveDurableCurrentLink).toHaveBeenCalledTimes(2);
        expect(resolveDurableCurrentLink.mock.calls[0]?.[0]).toMatchObject({
            signal: expect.any(AbortSignal),
            deadlineAtMs: expect.any(Number),
        });
        expect(resolveDurableCurrentLink.mock.calls[1]?.[0]).toMatchObject({
            sessionId: 'session-1',
            signal: resolveDurableCurrentLink.mock.calls[0]?.[0].signal,
            deadlineAtMs:
                resolveDurableCurrentLink.mock.calls[0]?.[0].deadlineAtMs,
        });
        expect(owner.publishField).toHaveBeenCalledWith({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: expect.objectContaining({
                status: 'idle',
                linkGeneration: '1',
            }),
        });
        expect(owner.acquireObserver).not.toHaveBeenCalled();
        expect(owner.requestTranscriptRefresh).not.toHaveBeenCalled();

        await owner.projection.dispose();
    });

    it('rejects when the durable link is replaced before fact admission', async () => {
        const resolveDurableCurrentLink = vi.fn<ResolveDurableCurrentLink>()
            .mockResolvedValueOnce(durableLink('1'))
            .mockResolvedValueOnce(durableLink('2'));
        const owner = setup(resolveDurableCurrentLink);

        await expect(owner.ingress.handleAuthenticatedEvent({
            token: owner.principal.token,
            eventId: 'session-stop',
            observedAtMs: owner.nowMs,
            forwardingStartedAtMs: owner.nowMs,
            nativePayload: { session_id: 'native-session-1' },
            signal: new AbortController().signal,
        })).resolves.toEqual({ state: 'rejected' });
        await owner.projection.flush();

        expect(owner.publishField).not.toHaveBeenCalled();
        expect(owner.acquireObserver).not.toHaveBeenCalled();
        expect(owner.requestTranscriptRefresh).not.toHaveBeenCalled();

        await owner.projection.dispose();
    });
});
