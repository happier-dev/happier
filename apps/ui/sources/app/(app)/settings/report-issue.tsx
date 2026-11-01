import React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { BugReportComposerView } from '@/components/settings/bugReports/BugReportComposerView';

export default function ReportIssueScreen() {
    const params = useLocalSearchParams<{ sessionId?: string; serverId?: string; accountId?: string }>();
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
    const serverId = typeof params.serverId === 'string' ? params.serverId.trim() : '';
    return <BugReportComposerView initialSessionTarget={sessionId && serverId ? {
        sessionId,
        serverId,
        // An empty account marker means the launcher could not bind the selection.
        accountId: typeof params.accountId === 'string' ? params.accountId.trim() || null : null,
    } : null} />;
}
