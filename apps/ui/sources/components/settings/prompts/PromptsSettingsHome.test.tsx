import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
const useFeatureEnabledMock = vi.hoisted(() => vi.fn((featureId: string) => (
    featureId === 'prompts.assets.external' || featureId === 'prompts.skills.registries'
)));

vi.mock('react-native', () => ({
    ScrollView: 'ScrollView',
    View: 'View',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (fn: any) => fn({
            colors: {
                groupped: { background: 'white' },
            },
        }),
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                accent: { blue: 'blue', indigo: 'indigo' },
                textSecondary: 'gray',
                groupped: { background: 'white' },
            },
        },
    }),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
    Stack: { Screen: () => null },
}));

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

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => useFeatureEnabledMock(featureId),
}));

beforeEach(() => {
    vi.resetModules();
    routerPushSpy.mockClear();
    useFeatureEnabledMock.mockImplementation((featureId: string) => (
        featureId === 'prompts.assets.external' || featureId === 'prompts.skills.registries'
    ));
});

describe('PromptsSettingsHome', () => {
    it('includes library entries for prompts and skills plus the remaining settings sections when enabled', async () => {
        const { PromptsSettingsHome } = await import('./PromptsSettingsHome');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(PromptsSettingsHome));
        });

        const items = tree.root.findAllByType('Item' as any);
        const promptsItem = items.find((i: any) => i?.props?.testID === 'settings-prompts-library-prompts');
        const skillsItem = items.find((i: any) => i?.props?.testID === 'settings-prompts-library-skills');
        const foldersItem = items.find((i: any) => i?.props?.testID === 'settings-prompts-folders');
        const templatesItem = items.find((i: any) => i?.props?.testID === 'settings-prompts-templates');
        const stacksItem = items.find((i: any) => i?.props?.testID === 'settings-prompts-stacks');
        const assetsItem = items.find((i: any) => i?.props?.testID === 'settings-prompts-assets');
        const registriesItem = items.find((i: any) => i?.props?.testID === 'settings-prompts-registries');

        expect(promptsItem).toBeTruthy();
        expect(skillsItem).toBeTruthy();
        expect(foldersItem).toBeTruthy();
        expect(templatesItem).toBeTruthy();
        expect(stacksItem).toBeTruthy();
        expect(assetsItem).toBeTruthy();
        expect(registriesItem).toBeTruthy();

        await act(async () => {
            promptsItem?.props?.onPress?.();
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/prompts/docs');

        await act(async () => {
            skillsItem?.props?.onPress?.();
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/prompts/skills');

        await act(async () => {
            foldersItem?.props?.onPress?.();
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/prompts/folders');

        await act(async () => {
            templatesItem?.props?.onPress?.();
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/prompts/templates');

        await act(async () => {
            stacksItem?.props?.onPress?.();
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/prompts/stacks');

        await act(async () => {
            assetsItem?.props?.onPress?.();
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/prompts/assets');

        await act(async () => {
            registriesItem?.props?.onPress?.();
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/prompts/registries');
    });
});
