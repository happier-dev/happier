import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createFeatureDecision } from '@happier-dev/protocol/features/decision';
import type { VerifiedRunnerArtifactV1 } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';

import { renderHook } from '@/dev/testkit';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import {
    resolveTemporaryComputerDestinationProjectionState,
    resolveTemporaryComputerEligibility,
    useTemporaryComputerAvailability,
} from './useTemporaryComputerAvailability';

const boundary = vi.hoisted(() => ({
    listArtifactsByEndpoint: new Map<string, ReturnType<typeof vi.fn>>(),
    observedScopes: [] as Array<{ serverId: string; accountId: string }>,
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({
        featureId: 'sessions.ephemeralRunner',
        state: 'enabled',
        blockedBy: null,
        blockerCode: 'none',
        diagnostics: [],
        evaluatedAt: 1,
        scope: { scopeKind: 'spawn', serverId: 'server-a' },
    }),
}));

vi.mock('@/sync/http/client', () => ({
    createServerFetchAtEndpoint: ({ endpointUrl }: { endpointUrl: string }) => ({ endpointUrl }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope', () => ({
    createServerRequestForServerAccountScope: ({ scope, activeRequest }: {
        scope: { serverId: string; accountId: string };
        activeRequest: { endpointUrl: string };
    }) => {
        boundary.observedScopes.push(scope);
        return activeRequest;
    },
}));

vi.mock('@/sync/api/ephemeralRunner/runnerActivationClient', () => ({
    createRunnerActivationClient: ({ endpointUrl }: { endpointUrl: string }) => ({
        listArtifacts: boundary.listArtifactsByEndpoint.get(endpointUrl)!,
    }),
}));

const profile = {
    id: 'server-a', name: 'Home', serverUrl: 'https://home.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1,
    homeConnectionDescriptor: {
        v: 1 as const,
        homeServerIdentityId: 'srv_home_a',
        canonicalServerUrl: 'https://home.test',
        revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://home.test' }],
    },
} satisfies ServerProfile;

const decision = (state: 'enabled' | 'disabled') => createFeatureDecision({
    featureId: 'sessions.ephemeralRunner',
    state,
    blockedBy: state === 'enabled' ? null : 'server',
    blockerCode: state === 'enabled' ? 'none' : 'feature_disabled',
    diagnostics: [],
    evaluatedAt: 1,
    scope: { scopeKind: 'spawn', serverId: 'server-a' },
});

describe('Temporary computer eligibility', () => {
    it('requires the canonical feature decision, exact Home identity and an interactive context', () => {
        expect(resolveTemporaryComputerEligibility({ decision: null, interactive: true, profile, accountScopeAvailable: true })).toBe('loading');
        expect(resolveTemporaryComputerEligibility({ decision: decision('disabled'), interactive: true, profile, accountScopeAvailable: true })).toBe('feature_disabled');
        expect(resolveTemporaryComputerEligibility({ decision: decision('enabled'), interactive: false, profile, accountScopeAvailable: true })).toBe('automation_unsupported');
        expect(resolveTemporaryComputerEligibility({ decision: decision('enabled'), interactive: true, profile: { ...profile, homeConnectionDescriptor: undefined }, accountScopeAvailable: true })).toBe('home_identity_unavailable');
        expect(resolveTemporaryComputerEligibility({ decision: decision('enabled'), interactive: true, profile, accountScopeAvailable: false })).toBe('account_scope_unavailable');
        expect(resolveTemporaryComputerEligibility({ decision: decision('enabled'), interactive: true, profile, accountScopeAvailable: true })).toBe('eligible');
    });

    it.each([
        { label: 'loading', availability: { status: 'loading', retry: vi.fn() } as const, expected: 'pending' },
        { label: 'known-empty artifact list', availability: { status: 'unavailable', reason: 'artifact_unavailable', retry: vi.fn() } as const, expected: 'empty' },
        { label: 'failed artifact request', availability: { status: 'unavailable', reason: 'request_failed', retry: vi.fn() } as const, expected: 'pending' },
        {
            label: 'available artifact',
            availability: {
                status: 'available',
                artifacts: [{ identity: { target: 'linux-x64' } } as unknown as VerifiedRunnerArtifactV1],
                client: { listArtifacts: vi.fn() } as never,
                retry: vi.fn(),
            } as const,
            expected: 'available',
        },
    ])('classifies a $label projection as $expected for destination completeness', ({ availability, expected }) => {
        expect(resolveTemporaryComputerDestinationProjectionState(availability)).toBe(expected);
    });

    it('does not expose a completed artifact projection from the previous exact Home', async () => {
        boundary.observedScopes.length = 0;
        const listHomeA = vi.fn().mockResolvedValue({
            artifacts: [{ identity: { target: 'linux-x64' } } as unknown as VerifiedRunnerArtifactV1],
        });
        let resolveHomeB!: (value: { artifacts: VerifiedRunnerArtifactV1[] }) => void;
        const listHomeB = vi.fn().mockImplementation(() => new Promise((resolve) => {
            resolveHomeB = resolve;
        }));
        boundary.listArtifactsByEndpoint.set('https://home.test', listHomeA);
        boundary.listArtifactsByEndpoint.set('https://home-b.test', listHomeB);
        const homeB = {
            ...profile,
            id: 'server-b',
            serverUrl: 'https://home-b.test',
            homeConnectionDescriptor: {
                ...profile.homeConnectionDescriptor,
                homeServerIdentityId: 'srv_home_b',
                canonicalServerUrl: 'https://home-b.test',
                endpoints: [{ kind: 'https' as const, url: 'https://home-b.test' }],
            },
        } satisfies ServerProfile;
        const hook = await renderHook((props: { serverId: string; profile: ServerProfile }) => (
            useTemporaryComputerAvailability({
                serverId: props.serverId,
                accountScope: { serverId: props.serverId, accountId: props.serverId === 'server-a' ? 'account-a' : 'account-b' },
                profile: props.profile,
                interactive: true,
            })
        ), { initialProps: { serverId: 'server-a', profile } });

        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('available'));
        expect(boundary.observedScopes).toContainEqual({ serverId: 'server-a', accountId: 'account-a' });
        await hook.rerender({ serverId: 'server-b', profile: homeB });
        expect(hook.getCurrent().status).toBe('loading');

        await act(async () => resolveHomeB({ artifacts: [] }));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({
            status: 'unavailable',
            reason: 'artifact_unavailable',
        }));
        expect(boundary.observedScopes).toContainEqual({ serverId: 'server-b', accountId: 'account-b' });
        await hook.unmount();
    });

    it('fails closed without reading artifacts when the Account scope belongs to another Home', async () => {
        boundary.observedScopes.length = 0;
        const listArtifacts = vi.fn(async () => ({ artifacts: [] }));
        boundary.listArtifactsByEndpoint.set('https://home.test', listArtifacts);
        const hook = await renderHook(() => useTemporaryComputerAvailability({
            serverId: 'server-a',
            accountScope: { serverId: 'server-b', accountId: 'account-b' },
            profile,
            interactive: true,
        }));

        expect(hook.getCurrent()).toMatchObject({
            status: 'unavailable',
            reason: 'account_scope_unavailable',
        });
        expect(listArtifacts).not.toHaveBeenCalled();
        expect(boundary.observedScopes).toEqual([]);
        await hook.unmount();
    });

    it('re-resolves artifact authority when the exact Account changes on the same Home', async () => {
        boundary.observedScopes.length = 0;
        const listArtifacts = vi.fn(async () => ({
            artifacts: [{ identity: { target: 'linux-x64' } } as unknown as VerifiedRunnerArtifactV1],
        }));
        boundary.listArtifactsByEndpoint.set('https://home.test', listArtifacts);
        const hook = await renderHook((props: { accountId: string }) => (
            useTemporaryComputerAvailability({
                serverId: 'server-a',
                accountScope: { serverId: 'server-a', accountId: props.accountId },
                profile,
                interactive: true,
            })
        ), { initialProps: { accountId: 'account-a' } });

        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('available'));
        await hook.rerender({ accountId: 'account-b' });
        await vi.waitFor(() => expect(listArtifacts).toHaveBeenCalledTimes(2));
        expect(boundary.observedScopes).toEqual([
            { serverId: 'server-a', accountId: 'account-a' },
            { serverId: 'server-a', accountId: 'account-b' },
        ]);
        await hook.unmount();
    });

    it('cancels the safe artifact projection read when the exact Home is superseded or the picker unmounts', async () => {
        const signals: AbortSignal[] = [];
        const pending = vi.fn().mockImplementation((signal: AbortSignal) => {
            signals.push(signal);
            return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        });
        boundary.listArtifactsByEndpoint.set('https://home.test', pending);
        boundary.listArtifactsByEndpoint.set('https://home-b.test', pending);
        const homeB = {
            ...profile,
            id: 'server-b',
            serverUrl: 'https://home-b.test',
            homeConnectionDescriptor: {
                ...profile.homeConnectionDescriptor,
                homeServerIdentityId: 'srv_home_b',
                canonicalServerUrl: 'https://home-b.test',
                endpoints: [{ kind: 'https' as const, url: 'https://home-b.test' }],
            },
        } satisfies ServerProfile;
        const hook = await renderHook((props: { serverId: string; profile: ServerProfile }) => (
            useTemporaryComputerAvailability({
                serverId: props.serverId,
                accountScope: { serverId: props.serverId, accountId: props.serverId === 'server-a' ? 'account-a' : 'account-b' },
                profile: props.profile,
                interactive: true,
            })
        ), { initialProps: { serverId: 'server-a', profile } });

        await vi.waitFor(() => expect(signals).toHaveLength(1));
        await hook.rerender({ serverId: 'server-b', profile: homeB });
        expect(signals[0]?.aborted).toBe(true);

        await vi.waitFor(() => expect(signals).toHaveLength(2));
        await hook.unmount();
        expect(signals[1]?.aborted).toBe(true);
        // A canceled read never resolves into a typed unavailable reason.
        expect(hook.getCurrent().status).toBe('loading');
    });
});
