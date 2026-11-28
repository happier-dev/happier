import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';

import {
    readConnectedServiceAuthGroupsLoadStatus,
    useConnectedServiceAuthGroups,
    type UseConnectedServiceAuthGroupsParams,
} from './useConnectedServiceAuthGroups';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const authState = vi.hoisted(() => ({
    credentials: { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as
        | { token: string; secret: string }
        | null,
}));

const authGroupApiSpies = vi.hoisted(() => ({
    listConnectedServiceAuthGroupsV3: vi.fn(),
    createConnectedServiceAuthGroupV3: vi.fn(),
}));
const modalSpies = vi.hoisted(() => ({
    prompt: vi.fn(async () => 'Created Team'),
    consentAnswer: 'common.cancel',
    alertAsync: vi.fn(),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
}));

vi.mock('@/sync/api/account/apiConnectedServiceAuthGroupsV3', () => authGroupApiSpies);

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    modalSpies.alertAsync.mockImplementation(async (_title: string, _message?: string, buttons?: Array<{ text: string; onPress?: () => void }>) => {
        buttons?.find((button) => button.text === modalSpies.consentAnswer)?.onPress?.();
    });
    return createModalModuleMock({ spies: { prompt: modalSpies.prompt, alertAsync: modalSpies.alertAsync } }).module;
});

vi.mock('@/sync/sync', () => ({
    sync: { refreshProfile: vi.fn(async () => undefined) },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const defaultParams: UseConnectedServiceAuthGroupsParams = {
    serviceId: 'openai-codex',
    accountGroupsEnabled: true,
    groupConfigurationSupported: true,
    runtimeGroupFallbackSupported: true,
    serviceProjectionSignature: 'profiles:v1',
};

function buildGroup(overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'primary',
        displayName: 'Team pool',
        policy: {
            v: 1,
            strategy: 'priority',
            autoSwitch: false,
            switchOn: {
                usageLimit: true,
                authExpired: true,
                accountChanged: true,
                refreshFailure: false,
            },
            cooldownMs: 30_000,
            honorProviderResetsAt: true,
            autoRestorePrimaryWhenReset: false,
            maxSwitchesPerTurn: 1,
            maxSwitchesPerSessionHour: 3,
            softSwitchRemainingPercent: 15,
            probeIfSnapshotOlderThanMs: 300_000,
            recoveryMode: 'switch_or_wait',
        },
        activeProfileId: 'work',
        generation: 2,
        state: { status: 'ready' },
        createdAt: 1,
        updatedAt: 2,
        members: [],
        ...overrides,
    };
}

describe('useConnectedServiceAuthGroups', () => {
    beforeEach(() => {
        authState.credentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') };
        authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockReset();
        authGroupApiSpies.createConnectedServiceAuthGroupV3.mockReset();
        modalSpies.prompt.mockClear();
        modalSpies.prompt.mockResolvedValue('Created Team');
        authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockResolvedValue([buildGroup()]);
    });

    it('reports loading before the first authoritative groups response completes', async () => {
        let resolveGroups: ((groups: unknown[]) => void) | undefined;
        authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockImplementationOnce(
            () => new Promise((resolve) => {
                resolveGroups = resolve;
            }),
        );

        const hook = await renderHook(() => useConnectedServiceAuthGroups(defaultParams), {
            flushOptions: { cycles: 1, turns: 1 },
        });

        expect(hook.getCurrent()).toMatchObject({
            groups: [],
            loadStatus: 'loading',
        });
        expect(readConnectedServiceAuthGroupsLoadStatus(hook.getCurrent().groups)).toBe('loading');

        await act(async () => {
            resolveGroups?.([buildGroup()]);
            await flushHookEffects();
        });

        expect(hook.getCurrent()).toMatchObject({
            groups: [buildGroup()],
            loadStatus: 'loaded',
        });
        expect(readConnectedServiceAuthGroupsLoadStatus(hook.getCurrent().groups)).toBe('loaded');
    });

    it('keeps last-known-good groups while a projection refresh is pending', async () => {
        const hook = await renderHook(
            (params: typeof defaultParams) => useConnectedServiceAuthGroups(params),
            { initialProps: defaultParams },
        );
        expect(hook.getCurrent()).toMatchObject({
            groups: [buildGroup()],
            loadStatus: 'loaded',
        });

        let resolveRefresh: ((groups: unknown[]) => void) | undefined;
        authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockImplementationOnce(
            () => new Promise((resolve) => {
                resolveRefresh = resolve;
            }),
        );

        await hook.rerender({
            ...defaultParams,
            serviceProjectionSignature: 'profiles:v2',
        });

        expect(hook.getCurrent()).toMatchObject({
            groups: [buildGroup()],
            loadStatus: 'refreshing',
        });
        expect(readConnectedServiceAuthGroupsLoadStatus(hook.getCurrent().groups)).toBe('refreshing');

        const refreshed = buildGroup({ generation: 3 });
        await act(async () => {
            resolveRefresh?.([refreshed]);
            await flushHookEffects();
        });

        expect(hook.getCurrent()).toMatchObject({
            groups: [refreshed],
            loadStatus: 'loaded',
        });
    });

    it('clears previous-provider groups while a different service is loading', async () => {
        const hook = await renderHook(
            (params: UseConnectedServiceAuthGroupsParams) => useConnectedServiceAuthGroups(params),
            { initialProps: defaultParams },
        );
        expect(hook.getCurrent()).toMatchObject({
            groups: [buildGroup()],
            loadStatus: 'loaded',
        });

        let resolveGroups: ((groups: unknown[]) => void) | undefined;
        authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockImplementationOnce(
            () => new Promise((resolve) => {
                resolveGroups = resolve;
            }),
        );

        await hook.rerender({
            ...defaultParams,
            serviceId: 'anthropic',
            serviceProjectionSignature: 'anthropic:v1',
        });

        expect(hook.getCurrent()).toMatchObject({
            groups: [],
            loadStatus: 'loading',
        });

        await act(async () => {
            resolveGroups?.([]);
            await flushHookEffects();
        });

        expect(hook.getCurrent()).toMatchObject({
            groups: [],
            loadStatus: 'loaded',
        });
    });

    it('keeps the created group visible when the immediate post-create refetch is stale', async () => {
        const existingGroup = buildGroup({ groupId: 'primary', displayName: 'Existing pool' });
        const createdGroup = buildGroup({ groupId: 'created-team', displayName: 'Created Team' });
        authGroupApiSpies.listConnectedServiceAuthGroupsV3.mockResolvedValue([existingGroup]);
        authGroupApiSpies.createConnectedServiceAuthGroupV3.mockResolvedValue(createdGroup);

        const hook = await renderHook(() => useConnectedServiceAuthGroups(defaultParams));

        await act(async () => {
            await hook.getCurrent().createPool();
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        expect(authGroupApiSpies.createConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            expect.objectContaining({
                serviceId: 'openai-codex',
                groupId: 'created-team',
                displayName: 'Created Team',
            }),
        );
        expect(hook.getCurrent().groups.map((group) => group.groupId)).toEqual([
            'primary',
            'created-team',
        ]);
    });

    it('creates pools for services that support pool configuration even without runtime fallback', async () => {
        const createdGroup = buildGroup({ groupId: 'created-team', displayName: 'Created Team' });
        authGroupApiSpies.createConnectedServiceAuthGroupV3.mockResolvedValue(createdGroup);

        const hook = await renderHook(() => useConnectedServiceAuthGroups({
            ...defaultParams,
            runtimeGroupFallbackSupported: false,
        }));

        await act(async () => {
            await hook.getCurrent().createPool();
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        expect(modalSpies.prompt).toHaveBeenCalled();
        expect(authGroupApiSpies.createConnectedServiceAuthGroupV3).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            expect.objectContaining({
                serviceId: 'openai-codex',
                groupId: 'created-team',
                displayName: 'Created Team',
            }),
        );
    });

    it.each([
        { answer: 'common.cancel', creates: false },
        { answer: 'common.continue', creates: true },
    ])('asks account-status consent before creating a consent-gated pool ($answer)', async ({ answer, creates }) => {
        modalSpies.consentAnswer = answer;
        modalSpies.alertAsync.mockClear();
        modalSpies.prompt.mockClear();
        authGroupApiSpies.createConnectedServiceAuthGroupV3.mockClear();
        authGroupApiSpies.createConnectedServiceAuthGroupV3.mockResolvedValue(
            buildGroup({ serviceId: 'antigravity', groupId: 'created-team', displayName: 'Created Team' }),
        );

        const hook = await renderHook(() => useConnectedServiceAuthGroups({ ...defaultParams, serviceId: 'antigravity' }));
        await act(async () => {
            await hook.getCurrent().createPool();
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        expect(modalSpies.alertAsync).toHaveBeenCalledWith(
            'connectedServices.accountStatusConsent.noticeTitle',
            'connectedServices.accountStatusConsent.noticeBody',
            expect.any(Array),
        );
        expect(modalSpies.prompt).toHaveBeenCalledTimes(creates ? 1 : 0);
        expect(authGroupApiSpies.createConnectedServiceAuthGroupV3).toHaveBeenCalledTimes(creates ? 1 : 0);
    });
});
