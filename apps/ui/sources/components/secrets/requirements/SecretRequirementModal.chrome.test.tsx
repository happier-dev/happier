import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { installModalComponentCommonModuleMocks } from '@/modal/components/modalComponentTestHelpers';
import { createPassThroughModule } from '@/dev/testkit/mocks/components';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';

installModalComponentCommonModuleMocks();

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerId: () => null,
}));

vi.mock('@/hooks/machine/useMachineEnvPresence', () => ({
    useMachineEnvPresence: () => ({
        isLoading: false,
        isPreviewEnvSupported: false,
        meta: {},
    }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    ...createStorageModuleStub({
        useMachine: () => null,
    }),
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => false,
}));

vi.mock('@/components/secrets/SecretsList', () => ({
    SecretsList: () => null,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemListStatic: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemListStatic', null, children ?? null),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemGroup', null, children ?? null),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: () => null,
}));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        onViewportLayout: () => {},
        onContentSizeChange: () => {},
        onScroll: () => {},
    }),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: () => null,
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: () => null,
}));

vi.mock('@/components/ui/text/Text', () => ({
    ...createPassThroughModule(['Text', 'TextInput']),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SecretRequirementModal', () => {
    it('drives modal card chrome when setChrome is provided', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { SecretRequirementModal } = await import('./SecretRequirementModal');

        const setChrome = vi.fn();

        await renderScreen(
            React.createElement(SecretRequirementModal, {
                profile: ({ id: 'p1', name: 'Profile' } satisfies Pick<AIBackendProfile, 'id' | 'name'>) as unknown as AIBackendProfile,
                secretEnvVarName: 'OPENAI_API_KEY',
                machineId: null,
                secrets: [],
                defaultSecretId: null,
                onResolve: () => {},
                onClose: () => {},
                setChrome,
            }),
        );

        expect(setChrome).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'card',
            }),
        );
    });
});
