import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

afterEach(() => {
    vi.resetModules();
});

function isTestInstance(value: ReactTestInstance | string): value is ReactTestInstance {
    return typeof value !== 'string';
}

function collectNestedPressables(root: ReactTestInstance): ReactTestInstance[] {
    const nested: ReactTestInstance[] = [];

    function walk(node: ReactTestInstance, hasPressableAncestor: boolean): void {
        const isPressable = String(node.type) === 'Pressable';
        if (isPressable && hasPressableAncestor) {
            nested.push(node);
        }

        for (const child of node.children) {
            if (isTestInstance(child)) {
                walk(child, hasPressableAncestor || isPressable);
            }
        }
    }

    walk(root, false);
    return nested;
}

describe('ConnectedServiceDetailProfilesGroup row actions', () => {
    it('keeps profile row action buttons outside the profile navigation pressable on web', async () => {
        const { ConnectedServiceDetailProfilesGroup } = await import('./detail/ConnectedServiceDetailProfilesGroup');
        const onOpenProfile = vi.fn();
        const screen = await renderScreen(
            <ConnectedServiceDetailProfilesGroup
                title="OpenAI Codex"
                serviceId="openai-codex"
                profiles={[{ profileId: 'work', status: 'connected', providerEmail: 'work@example.com' }]}
                defaultProfileId="work"
                profileLabelsByKey={{}}
                pinnedMeterIdsByKey={{}}
                quotaSummaryStrategyByKey={{}}
                quotaSnapshotsByKey={{}}
                quotasEnabled={false}
                onDisconnect={vi.fn()}
                onConnectOauth={vi.fn()}
                onOpenProfile={onOpenProfile}
                onSetDefaultProfile={vi.fn()}
                onEditProfileLabel={vi.fn()}
            />,
        );

        expect(collectNestedPressables(screen.root)).toHaveLength(0);

        const profileNavigation = screen.findByTestId('connected-services-profile:work:open');
        expect(profileNavigation).toBeTruthy();

        await pressTestInstanceAsync(profileNavigation);

        expect(onOpenProfile).toHaveBeenCalledWith('work');
    });
});
