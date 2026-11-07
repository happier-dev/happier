import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { SelectionList } from '@/components/ui/selectionList';
import { normalizeConnectedServiceQuotaProfileRefs, type ConnectedServiceQuotaProfileRefInput } from '@/sync/domains/connectedServices/connectedServiceQuotaProfileRefs';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const useConnectedServiceQuotaBadgesMock = vi.hoisted(() => vi.fn((_profiles: readonly ConnectedServiceQuotaProfileRefInput[], _options: unknown) => ({})));

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

const EMPTY_QUOTA_SNAPSHOTS = vi.hoisted(() => ({}));

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaBadges', () => ({
    useConnectedServiceQuotaBadgeState: (profiles: readonly ConnectedServiceQuotaProfileRefInput[], options: unknown) => ({ badgesByKey: useConnectedServiceQuotaBadgesMock(profiles, options), snapshotsByKey: EMPTY_QUOTA_SNAPSHOTS }),
}));

const { NewSessionConnectedServicesSelectionContent } = await import('./NewSessionConnectedServicesSelectionContent');

describe('NewSessionConnectedServicesSelectionContent', () => {
    it('uses measured native connected-services content height under the computed popover cap', async () => {
        useConnectedServiceQuotaBadgesMock.mockClear();

        const screen = await renderScreen(<NewSessionConnectedServicesSelectionContent
            supportedServiceIds={['happier.agent.codex/openai-codex']}
            profileOptionsByServiceId={{}}
            groupOptionsByServiceId={{}}
            bindingsByServiceId={{}}
            setBindingForService={() => {}}
            onOpenSettings={() => {}}
            maxHeight={360}
        />);

        expect(screen.findByType(SelectionList).props.heightBehavior).toBe('measuredToMaxHeight');
    });

    it('keeps a novel qualified service key intact for cache-only quota rows', async () => {
        useConnectedServiceQuotaBadgesMock.mockClear();

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

        const [profiles, options] = useConnectedServiceQuotaBadgesMock.mock.calls.at(-1)!;
        expect(normalizeConnectedServiceQuotaProfileRefs(profiles)).toEqual([
            expect.objectContaining({ kind: 'qualified', ref: {
                service: { pluginId: 'acme.review', localId: 'reviewer-service' }, accountId: 'work',
            } }),
        ]);
        expect(options).toEqual({ fetchPolicy: 'cache_only' });
    });
});
