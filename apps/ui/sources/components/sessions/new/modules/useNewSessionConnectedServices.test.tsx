import { renderHook } from '@/dev/testkit';
import { describe, expect, it, vi } from 'vitest';
import { installNewSessionModulesCommonModuleMocks } from './newSessionModulesTestHelpers';
import type { NewSessionConnectedServicesResult } from './useNewSessionConnectedServices';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const modalShowMock = vi.hoisted(() => vi.fn());
const profileState = vi.hoisted(() => ({
    current: {
        connectedServicesV2: [
            {
                serviceId: 'anthropic',
                profiles: [
                    {
                        profileId: 'work',
                        status: 'connected',
                        kind: 'token',
                        providerEmail: 'work@example.com',
                    },
                ],
            },
        ],
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

installNewSessionModulesCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: (...args: any[]) => modalShowMock(...args),
            },
        }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Pressable: 'Pressable',
            Platform: {
                OS: 'web',
                select: (spec: Record<string, unknown>) => spec.web ?? spec.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
});

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));

vi.mock('@/components/sessions/new/components/ConnectedServicesAuthModal', () => ({
    CONNECTED_SERVICES_BINDINGS_KEY: 'connectedServicesBindings',
    ConnectedServicesAuthModal: 'ConnectedServicesAuthModal',
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputChipLabel', () => ({
    AgentInputChipLabel: 'AgentInputChipLabel',
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => profileState.current,
}));

describe('useNewSessionConnectedServices', () => {
    it('returns a connected-services chip with canonical control metadata and a collapsed action', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        const dismiss = vi.fn();
        const routerPush = vi.fn();
        const setAgentOptionStateForCurrentAgent = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: {
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        supportedKindsByServiceId: { anthropic: ['token'] },
                    },
                },
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic:work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                router: { push: routerPush },
                setAgentOptionStateForCurrentAgent,
            }),
        );

        const chip = hook.getCurrent().connectedServicesAuthChip;
        expect(chip).toEqual(
            expect.objectContaining({
                key: 'new-session-connected-services-auth',
                controlId: 'connectedServices',
            }),
        );
        expect(typeof chip?.collapsedAction).toBe('function');
        if (!chip?.collapsedAction) {
            throw new Error('expected connectedServicesAuthChip.collapsedAction');
        }

        const collapsedActionResult = chip.collapsedAction({
            tint: '#000',
            dismiss,
            blurInput: () => {},
        });
        const collapsedAction = Array.isArray(collapsedActionResult)
            ? collapsedActionResult[0]
            : collapsedActionResult;
        expect(collapsedAction?.id).toBe('connected-services');
        if (!collapsedAction?.onPress) {
            throw new Error('expected connectedServicesAuthChip.collapsedAction.onPress');
        }

        collapsedAction.onPress();

        expect(dismiss).toHaveBeenCalledTimes(1);
        expect(modalShowMock).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });
});
