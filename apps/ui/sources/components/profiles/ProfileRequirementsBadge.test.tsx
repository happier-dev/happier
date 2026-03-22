import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';

const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/hooks/session/useProfileEnvRequirements', () => ({
    useProfileEnvRequirements: () => ({ isReady: false, isLoading: false }),
}));

vi.mock('@/sync/domains/profiles/profileSecrets', () => ({
    hasRequiredSecret: () => true,
}));

type TextMockProps = {
    children?: React.ReactNode;
} & Record<string, unknown>;

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: TextMockProps) => React.createElement('Text', props as never, children),
}));

const profile: AIBackendProfile = {
    id: 'p1',
    name: 'Profile',
    environmentVariables: [],
    defaultPermissionModeByTargetKey: {},
    defaultPermissionModeByAgent: {},
    defaultPersistenceModeByTargetKey: {},
    defaultPersistenceModeByAgent: {},
    compatibilityByTargetKey: {},
    compatibility: {},
    envVarRequirements: [{ name: 'OPENAI_API_KEY', kind: 'secret', required: true }],
    isBuiltIn: false,
    createdAt: 0,
    updatedAt: 0,
    version: '1.0.0',
};

describe('ProfileRequirementsBadge', () => {
    it('does not emit raw text nodes under View when icons render as text on web', async () => {
        const { ProfileRequirementsBadge } = await import('./ProfileRequirementsBadge');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ProfileRequirementsBadge
                    profile={profile}
                    machineId={null}
                />,
            );
        });

        const badNodes: Array<{ parent: string | null; value: string }> = [];
        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string' || typeof node === 'number') {
                const value = String(node);
                if (parentType !== 'Text' && value.trim().length > 0) badNodes.push({ parent: parentType, value });
                return;
            }
            if (Array.isArray(node)) {
                for (const item of node) walk(item, parentType);
                return;
            }
            const nextParent = typeof node.type === 'string' ? node.type : parentType;
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) walk(child, nextParent);
        };

        walk(tree.toJSON(), null);
        expect(badNodes).toEqual([]);

        act(() => {
            tree.unmount();
        });
    });
});
