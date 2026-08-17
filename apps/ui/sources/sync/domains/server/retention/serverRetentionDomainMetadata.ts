import type { TranslationKeyNoParams } from '@/text';

export type ServerRetentionDomainMetadata = Readonly<{
    key: string;
    titleKey: TranslationKeyNoParams;
}>;

export const SERVER_RETENTION_DOMAIN_METADATA: readonly ServerRetentionDomainMetadata[] = Object.freeze([
    { key: 'sessions', titleKey: 'server.retention.sessions' },
    { key: 'sessionSidechainMessages', titleKey: 'server.retention.sidechainMessages' },
    { key: 'accountChanges', titleKey: 'server.retention.accountChanges' },
    { key: 'usageEvents', titleKey: 'server.retention.usageEvents' },
    { key: 'voiceSessionLeases', titleKey: 'server.retention.voiceSessionLeases' },
    { key: 'userFeedItems', titleKey: 'server.retention.feedItems' },
    { key: 'sessionShareAccessLogs', titleKey: 'server.retention.sessionShareAccessLogs' },
    { key: 'publicShareAccessLogs', titleKey: 'server.retention.publicShareAccessLogs' },
    { key: 'terminalAuthRequests', titleKey: 'server.retention.terminalAuthRequests' },
    { key: 'accountAuthRequests', titleKey: 'server.retention.accountAuthRequests' },
    { key: 'authPairingSessions', titleKey: 'server.retention.authPairingSessions' },
    { key: 'repeatKeys', titleKey: 'server.retention.repeatKeys' },
    { key: 'globalLocks', titleKey: 'server.retention.globalLocks' },
    { key: 'automationRuns', titleKey: 'server.retention.automationRuns' },
    { key: 'automationRunEvents', titleKey: 'server.retention.automationRunEvents' },
]);

export function getServerRetentionDomainMetadata(id: string): ServerRetentionDomainMetadata | null {
    return SERVER_RETENTION_DOMAIN_METADATA.find((entry) => entry.key === id) ?? null;
}
