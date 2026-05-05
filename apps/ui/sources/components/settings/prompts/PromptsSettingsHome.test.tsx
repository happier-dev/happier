import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installPromptLibrarySettingsCommonModuleMocks,
    promptLibrarySettingsRouterPushSpy,
} from './promptLibrarySettingsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useFeatureEnabledMock = vi.hoisted(() => vi.fn((featureId: string) => (
    featureId === 'prompts.assets.external' || featureId === 'prompts.skills.registries'
)));

installPromptLibrarySettingsCommonModuleMocks();

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => useFeatureEnabledMock(featureId),
}));

beforeEach(() => {
    vi.resetModules();
    promptLibrarySettingsRouterPushSpy.mockClear();
    useFeatureEnabledMock.mockImplementation((featureId: string) => (
        featureId === 'prompts.assets.external' || featureId === 'prompts.skills.registries'
    ));
});

describe('PromptsSettingsHome', () => {
    it('includes library entries for prompts and skills plus the remaining settings sections when enabled', async () => {
        const { PromptsSettingsHome } = await import('./PromptsSettingsHome');

        const screen = await renderScreen(<PromptsSettingsHome />);

        const promptsItem = screen.findByTestId('settings-prompts-library-prompts');
        const skillsItem = screen.findByTestId('settings-prompts-library-skills');
        const foldersItem = screen.findByTestId('settings-prompts-folders');
        const templatesItem = screen.findByTestId('settings-prompts-templates');
        const stacksItem = screen.findByTestId('settings-prompts-stacks');
        const assetsItem = screen.findByTestId('settings-prompts-assets');
        const registriesItem = screen.findByTestId('settings-prompts-registries');

        expect(promptsItem).toBeTruthy();
        expect(skillsItem).toBeTruthy();
        expect(foldersItem).toBeTruthy();
        expect(templatesItem).toBeTruthy();
        expect(stacksItem).toBeTruthy();
        expect(assetsItem).toBeTruthy();
        expect(registriesItem).toBeTruthy();

        await screen.pressByTestIdAsync('settings-prompts-library-prompts');
        expect(promptLibrarySettingsRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/docs');

        await screen.pressByTestIdAsync('settings-prompts-library-skills');
        expect(promptLibrarySettingsRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/skills');

        await screen.pressByTestIdAsync('settings-prompts-folders');
        expect(promptLibrarySettingsRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/folders');

        await screen.pressByTestIdAsync('settings-prompts-templates');
        expect(promptLibrarySettingsRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/templates');

        await screen.pressByTestIdAsync('settings-prompts-stacks');
        expect(promptLibrarySettingsRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/stacks');

        await screen.pressByTestIdAsync('settings-prompts-assets');
        expect(promptLibrarySettingsRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/assets');

        await screen.pressByTestIdAsync('settings-prompts-registries');
        expect(promptLibrarySettingsRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/registries');
    });
});
