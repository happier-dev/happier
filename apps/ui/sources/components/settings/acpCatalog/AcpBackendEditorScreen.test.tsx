import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAcpCatalogSettingsCommonModuleMocks } from './acpCatalogSettingsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installAcpCatalogSettingsCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettingMutable: (key: string) => {
                if (key === 'acpCatalogSettingsV1') return [{ v: 2, backends: [] }, vi.fn()];
                if (key === 'secrets') return [[], vi.fn()];
                return [null, vi.fn()];
            },
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/settings/mcpServers/McpValueRefMapEditor', () => ({
    McpValueRefMapEditor: (props: any) => React.createElement('McpValueRefMapEditor', props),
}));

vi.mock('@/components/ui/settingsSurface/SettingsActionFooter', () => ({
    SettingsActionFooter: (props: any) => React.createElement('SettingsActionFooter', props),
}));

describe('AcpBackendEditorScreen', () => {
    it('opts its ItemList-sibling footer into bottom-chrome reservation', async () => {
        const { AcpBackendEditorScreen } = await import('./AcpBackendEditorScreen');
        const screen = await renderScreen(React.createElement(AcpBackendEditorScreen));

        expect(screen.root.findAllByType('ItemList')).toHaveLength(1);
        expect(screen.root.findByType('SettingsActionFooter').props.reserveBottomChromeInset).toBe(true);
    });
});
