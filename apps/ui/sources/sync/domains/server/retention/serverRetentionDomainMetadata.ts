import type { TranslationKeyNoParams } from '@/text';

export type ServerRetentionDomainMetadata = Readonly<{
    key: string;
    titleKey: TranslationKeyNoParams;
    /** The domain's clean-up runs even while automatic deletion is off (`runsWhenGlobalPolicyIsDisabled`). */
    runsWhenDeletionOff?: true;
    /** Records expire on their own; there is no age to choose. */
    expiresAutomatically?: true;
}>;

/**
 * How the app names each retention domain, in the order the Home console lists them (plan
 * `2026-09-26-home-owner-console` §3.6): the records people make first, then the Home's own. Which
 * group a domain belongs to is the Home's answer (`retention.user` / `retention.system`), not this list.
 */
export const SERVER_RETENTION_DOMAIN_METADATA: readonly ServerRetentionDomainMetadata[] = Object.freeze([
    { key: 'sessions', titleKey: 'server.retention.sessions' },
    { key: 'sessionSidechainMessages', titleKey: 'server.retention.sidechainMessages' },
    { key: 'usageEvents', titleKey: 'server.retention.usageEvents' },
    { key: 'providerAccountUsageHistory', titleKey: 'server.retention.providerAccountUsageHistory' },
    { key: 'automationRuns', titleKey: 'server.retention.automationRuns', runsWhenDeletionOff: true },
    { key: 'automationRunEvents', titleKey: 'server.retention.automationRunEvents' },
    { key: 'userFeedItems', titleKey: 'server.retention.feedItems' },
    { key: 'homeAdministrationEvents', titleKey: 'server.retention.homeAdministrationEvents' },
    { key: 'accountChanges', titleKey: 'server.retention.accountChanges' },
    { key: 'voiceSessionLeases', titleKey: 'server.retention.voiceSessionLeases' },
    { key: 'publicShareAccessLogs', titleKey: 'server.retention.publicShareAccessLogs', runsWhenDeletionOff: true },
    { key: 'terminalAuthRequests', titleKey: 'server.retention.terminalAuthRequests' },
    { key: 'accountAuthRequests', titleKey: 'server.retention.accountAuthRequests' },
    { key: 'authPairingSessions', titleKey: 'server.retention.authPairingSessions', runsWhenDeletionOff: true },
    { key: 'repeatKeys', titleKey: 'server.retention.repeatKeys', runsWhenDeletionOff: true, expiresAutomatically: true },
    { key: 'globalLocks', titleKey: 'server.retention.globalLocks' },
]);

export function getServerRetentionDomainMetadata(id: string): ServerRetentionDomainMetadata | null {
    return SERVER_RETENTION_DOMAIN_METADATA.find((entry) => entry.key === id) ?? null;
}
