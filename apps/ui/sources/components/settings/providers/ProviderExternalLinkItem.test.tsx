import * as React from 'react';
import { HappierLink } from '@happier-dev/plugin-ui/presentation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => 'middle',
}));

vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
    getItemGroupRowCornerRadii: () => ({}),
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: unknown) => node,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('Text', props, children),
}));

vi.mock('@/constants/Typography', () => ({
    FontWeights: { regular: '400', semiBold: '500' },
    getMonoFont: () => 'monospace',
    Typography: {
        default: () => ({}),
        rowTitle: () => ({ fontSize: 16, lineHeight: 20 }),
        rowMeta: () => ({ fontSize: 14, lineHeight: 18 }),
        pillLabel: () => ({ fontSize: 12, lineHeight: 16 }),
        timestamp: () => ({ fontSize: 12, lineHeight: 16 }),
        keyHint: () => ({ fontSize: 12, lineHeight: 16 }),
    },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => 'comfortable',
}));

function findProviderLink(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.findAllByType(HappierLink).find((node) => (
        node.props.label === 'settingsProviders.links.providerWebsite'
        && typeof node.props.onPress === 'function'
    ));
}

describe('ProviderExternalLinkItem', () => {
    afterEach(standardCleanup);

    it('renders the external link through HappierLink', async () => {
        const { ProviderExternalLinkItem } = await import('./ProviderExternalLinkItem');
        const screen = await renderScreen(
            <ProviderExternalLinkItem kind="providerWebsite" url="https://provider.example.test" />,
        );
        const link = findProviderLink(screen);

        expect(link?.props.label).toBe('settingsProviders.links.providerWebsite');
    });
});
