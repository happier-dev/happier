import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SelectionList } from '@/components/ui/selectionList';
import type { SessionRoute } from '@/providers/session/resolveSessionRoutePresentation';
import { renderScreen } from '@/dev/testkit';

import { createTeamResourceServiceOptionId } from './buildNewSessionConnectedServicesSelectionListModel';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NO_QUOTA_BADGES = vi.hoisted(() => ({}));

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

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));

const EMPTY_QUOTA_SNAPSHOTS = vi.hoisted(() => ({}));

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaBadges', () => ({
    useConnectedServiceQuotaBadgeState: () => ({ badgesByKey: NO_QUOTA_BADGES, snapshotsByKey: EMPTY_QUOTA_SNAPSHOTS }),
}));

const SERVICE = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
const SERVICE_ID = 'happier.agent.codex/openai-codex';
const SELECTION = { source: 'team_resource' as const, resourceId: 'resource-1', deliveryMode: 'brokered' as const };
const { NewSessionConnectedServicesSelectionContent } = await import('./NewSessionConnectedServicesSelectionContent');

describe('NewSessionConnectedServicesSelectionContent on a Team route', () => {
    async function renderRoute(appliedRoute: SessionRoute, bound: boolean) {
        const screen = await renderScreen(
            <NewSessionConnectedServicesSelectionContent
                supportedServiceIds={[SERVICE_ID]}
                profileOptionsByServiceId={{}}
                groupOptionsByServiceId={{}}
                bindingsByServiceId={bound ? { [SERVICE_ID]: SELECTION } : {}}
                nativeAgentTargetKey="agent:happier.agent.codex/codex"
                appliedRoute={appliedRoute}
                teamCredentialResources={[{
                    id: 'resource-1', teamId: 'team-1', displayName: 'QA43 Leeroy brokered', sourceOwnerDisplayName: null, resourceRevision: 1,
                    readiness: { kind: 'available' }, recoveryAction: null,
                    mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
                    sessionUsePolicy: 'personal_allowed', providerModels: [],
                    sourcePresentation: { kind: 'connected_service', service: SERVICE },
                    connectedServiceSelections: [SELECTION],
                }]}
                setBindingForService={() => {}}
                onOpenSettings={() => {}}
                maxHeight={420}
            />,
        );
        return screen.findByType(SelectionList).props;
    }

    const TEAM_ROUTE: SessionRoute = {
        kind: 'team', teamId: 'team-1', resourceId: 'resource-1', deliveryMode: 'brokered',
        sourceLabel: 'QA43 Leeroy brokered', modelId: 'gpt-5.6-luna',
    };

    // A Session's route follows its model selection, so it can name a Team source while the Session carries
    // no connected-service binding: the applied route is what the chip says, and the row must agree with it.
    it('checks the Team row the applied route names, with or without a binding on the session', async () => {
        const expected = createTeamResourceServiceOptionId(SELECTION);
        expect((await renderRoute(TEAM_ROUTE, false)).selectedOptionId).toBe(expected);
        expect((await renderRoute(TEAM_ROUTE, true)).selectedOptionId).toBe(expected);
    });

    it('checks nothing rather than its own sign-in when the applied Team source is not in the catalog', async () => {
        const list = await renderRoute({ ...TEAM_ROUTE, resourceId: 'resource-gone' }, false);
        expect(list.selectedOptionId).toBeNull();
    });
});
