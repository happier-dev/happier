import { Redirect, useLocalSearchParams } from 'expo-router';

import { resolveNewSessionDraftRouteIdentity } from '@/components/sessions/new/navigation/newSessionDraftRouteIdentity';

type AutomationPickerParams = Readonly<{
    draftId?: string;
}>;

export default function AutomationPickerRoute() {
    const params = useLocalSearchParams<AutomationPickerParams>();
    const draftId = resolveNewSessionDraftRouteIdentity({ routeDraftId: params.draftId }).draftId;

    return (
        <Redirect
            href={{
                pathname: '/new',
                params: {
                    automation: '1',
                    draftId,
                },
            }}
        />
    );
}
