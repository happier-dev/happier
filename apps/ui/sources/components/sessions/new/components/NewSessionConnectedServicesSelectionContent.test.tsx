import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capturedSelectionLists = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const useConnectedServiceQuotaBadgesMock = vi.hoisted(() => vi.fn((_profiles: unknown, _options: unknown) => ({})));

installNewSessionComponentsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'ios' } });
    },
    icons: () => ({
        Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/ui/selectionList', () => ({
    SelectionList: (props: Record<string, unknown>) => {
        capturedSelectionLists.push(props);
        return React.createElement('SelectionList', props);
    },
    resolvePopoverSelectionListHeightBehavior: () => 'measuredToMaxHeight',
}));

vi.mock('@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName', () => ({
    resolveConnectedServiceDisplayName: (id: string) => id,
}));

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaBadges', () => ({
    useConnectedServiceQuotaBadges: (profiles: unknown, options: unknown) => useConnectedServiceQuotaBadgesMock(profiles, options),
}));

vi.mock('./buildNewSessionConnectedServicesSelectionListModel', () => ({
    buildNewSessionConnectedServicesSelectionListModel: () => ({
        rootStep: {
            id: 'root',
            sections: [{ kind: 'static', id: 'services', options: [{ id: 'service:codex', label: 'Codex' }] }],
        },
        selectedOptionId: 'service:codex',
    }),
}));

describe('NewSessionConnectedServicesSelectionContent', () => {
    it('uses measured native connected-services content height under the computed popover cap', async () => {
        capturedSelectionLists.length = 0;
        useConnectedServiceQuotaBadgesMock.mockClear();
        const { NewSessionConnectedServicesSelectionContent } = await import('./NewSessionConnectedServicesSelectionContent');

        await renderScreen(<NewSessionConnectedServicesSelectionContent
            supportedServiceIds={['happier.agent.codex/openai-codex']}
            profileOptionsByServiceId={{}}
            groupOptionsByServiceId={{}}
            bindingsByServiceId={{}}
            setBindingForService={() => {}}
            onOpenSettings={() => {}}
            maxHeight={360}
        />);

        expect(capturedSelectionLists[0]?.heightBehavior).toBe('measuredToMaxHeight');
    });

    it('keeps a novel qualified service key intact for cache-only quota rows', async () => {
        capturedSelectionLists.length = 0;
        useConnectedServiceQuotaBadgesMock.mockClear();
        const { NewSessionConnectedServicesSelectionContent } = await import('./NewSessionConnectedServicesSelectionContent');

        await renderScreen(<NewSessionConnectedServicesSelectionContent
            supportedServiceIds={['acme.review/reviewer-service']}
            profileOptionsByServiceId={{
                'acme.review/reviewer-service': [{
                    profileId: 'work',
                    status: 'connected',
                    providerEmail: 'work@example.com',
                }],
            }}
            groupOptionsByServiceId={{}}
            bindingsByServiceId={{}}
            setBindingForService={() => {}}
            onOpenSettings={() => {}}
            maxHeight={360}
        />);

        expect(useConnectedServiceQuotaBadgesMock).toHaveBeenCalledWith(
            [{ serviceId: 'acme.review/reviewer-service', profileId: 'work' }],
            { fetchPolicy: 'cache_only' },
        );
    });
});
