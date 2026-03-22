import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useLocalSearchParamsMock = vi.hoisted(() => vi.fn(() => ({
    machineId: 'machine-1',
    sourceId: 'skills_sh:featured',
    itemId: 'item-1',
    title: 'frontend-design',
    displayPath: 'anthropics/skills/frontend-design',
    workspacePath: '/tmp/project',
})));

const promptRegistryItemDetailsScreenMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        params: () => useLocalSearchParamsMock(),
    });
    return expoRouterMock.module;
});

vi.mock('@/components/settings/prompts/registries/PromptRegistryItemDetailsScreen', () => ({
    PromptRegistryItemDetailsScreen: (props: unknown) => {
        promptRegistryItemDetailsScreenMock(props);
        return null;
    },
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useSettingMutable: () => [{ v: 1, sources: [] }, vi.fn()],
});
});

describe('PromptRegistryItemDetailsRoute', () => {
    it('forwards workspacePath params to the details screen', async () => {
        const Route = (await import('@/app/(app)/settings/prompts/registries/item')).default;
        await renderScreen(<Route />);

        expect(promptRegistryItemDetailsScreenMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            sourceId: 'skills_sh:featured',
            itemId: 'item-1',
            title: 'frontend-design',
            displayPath: 'anthropics/skills/frontend-design',
            workspacePath: '/tmp/project',
            configuredSources: [],
        }));
    });
});
