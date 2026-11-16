import * as React from 'react';

import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { ActionSettingsDetailView } from './ActionSettingsDetailView';
import { ActionsSettingsView } from './ActionsSettingsView';

function readParam(value: string | string[] | undefined): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    return raw ? decodeURIComponent(raw) : null;
}

/** Settings → Actions → a profile: the Actions list itself, editing that profile instead of the Account. */
export const ApprovalProfileSettingsView = React.memo(function ApprovalProfileSettingsView() {
    const params = useLocalSearchParams<{ profileId?: string | string[] }>();
    const profileId = readParam(params.profileId) ?? '';
    const target = React.useMemo(() => ({ kind: 'profile' as const, id: profileId }), [profileId]);
    return <ActionsSettingsView target={target} />;
});

/** One Action inside a profile: the Action's own page, editing that profile. */
export const ApprovalProfileActionSettingsView = React.memo(function ApprovalProfileActionSettingsView() {
    const params = useLocalSearchParams<{ profileId?: string | string[] }>();
    const profileId = readParam(params.profileId) ?? '';
    const target = React.useMemo(() => ({ kind: 'profile' as const, id: profileId }), [profileId]);
    return <ActionSettingsDetailView target={target} />;
});
