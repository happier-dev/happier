import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const captured = vi.hoisted(() => ({
    dropdownProps: null as any,
}));

installNewSessionComponentsCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => {
        captured.dropdownProps = props;
        return React.createElement('DropdownMenu', props);
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.rightElement ?? null),
}));

describe('NewSessionModelSelectionContent', () => {
    it('uses the selected model as dropdown subtitle and hides the duplicate selected detail', async () => {
        const { NewSessionModelSelectionContent } = await import('./NewSessionModelSelectionContent');

        await renderScreen(<NewSessionModelSelectionContent
            presentation="compact"
            modelOptions={[
                { value: 'default', label: 'Use CLI settings', description: '' },
                { value: 'model-a', label: 'Model A', description: 'A model' },
            ]}
            selectedModelId="default"
            selectedIndicatorColor="#fff"
            onSelectModel={() => {}}
        />);

        expect(captured.dropdownProps?.itemTrigger).toMatchObject({
            title: 'newSession.selectModelTitle',
            subtitle: 'Use CLI settings',
            showSelectedDetail: false,
            showSelectedSubtitle: false,
        });
    });

    it('does not render a favorite action for the CLI settings model in dropdown or list presentation', async () => {
        const { NewSessionModelSelectionContent } = await import('./NewSessionModelSelectionContent');
        const selectedBackendEntry = {
            backendTargetKey: 'agent:claude',
            backendTarget: { kind: 'backend', backendId: 'claude' },
            providerAgentId: 'claude',
            builtInAgentId: 'claude',
            title: 'Claude',
        };

        await renderScreen(<NewSessionModelSelectionContent
            presentation="compact"
            modelOptions={[
                { value: 'default', label: 'Use CLI settings', description: '' },
                { value: 'model-a', label: 'Model A', description: 'A model' },
            ]}
            selectedModelId="default"
            selectedIndicatorColor="#fff"
            selectedBackendEntry={selectedBackendEntry as any}
            favoriteModelSelections={[]}
            onFavoriteModelSelectionsChange={() => {}}
            onSelectModel={() => {}}
        />);

        const defaultItem = (captured.dropdownProps?.items ?? []).find((item: any) => item.id === 'default');
        const modelItem = (captured.dropdownProps?.items ?? []).find((item: any) => item.id === 'model-a');
        expect(defaultItem?.rightElement).toBeUndefined();
        expect(modelItem?.rightElement).toBeTruthy();
    });
});
