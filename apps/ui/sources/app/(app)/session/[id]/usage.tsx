import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { UsagePanel } from '@/components/settings/usage/UsagePanel';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';

export default function SessionUsageScreenRoute() {
    const params = useLocalSearchParams<{ id: string }>();
    const sessionId = normalizeSessionId(params.id);

    if (!sessionId) {
        return <SessionInvalidLinkFallback />;
    }

    return <UsagePanel sessionId={sessionId} />;
}
