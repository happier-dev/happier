import { t } from '@/text';

import type { ServerRetentionPolicy } from './serverRetentionPolicy';
import { SERVER_RETENTION_DOMAIN_METADATA, type ServerRetentionDomainKey } from './serverRetentionDomainMetadata';

type RetentionRow = Readonly<{
    key: string;
    title: string;
    detail: string;
}>;

function formatAgePolicy(policy: { mode: 'keep_forever' } | { mode: 'delete_older_than'; days: number }): string {
    if (policy.mode === 'keep_forever') {
        return t('server.retention.keepForever');
    }
    return t('server.retention.deleteOlderThanDays', { count: policy.days });
}

export function formatSessionRetentionSummary(policy: ServerRetentionPolicy | null | undefined): string | null {
    if (!policy) return null;
    if (policy.sessions.mode === 'keep_forever' || !policy.enabled) {
        return t('server.retention.keepForever');
    }
    return t('server.retention.sessionNotice', { count: policy.sessions.inactivityDays });
}

export function formatSavedServerRetentionSummary(policy: ServerRetentionPolicy | null | undefined): string | null {
    if (!policy || !policy.enabled || policy.sessions.mode === 'keep_forever') {
        return null;
    }

    return t('server.retention.deleteInactiveSessionsDays', { count: policy.sessions.inactivityDays });
}

function formatDomainPolicyDetail(params: {
    policy: ServerRetentionPolicy;
    domainKey: ServerRetentionDomainKey;
}): string {
    if (!params.policy.enabled) {
        return t('server.retention.keepForever');
    }

    const domainPolicy = params.policy[params.domainKey];
    if (domainPolicy.mode === 'keep_forever') {
        return t('server.retention.keepForever');
    }
    if (params.domainKey === 'sessions' && domainPolicy.mode === 'delete_inactive') {
        return t('server.retention.deleteInactiveSessionsDays', { count: domainPolicy.inactivityDays });
    }

    return formatAgePolicy(domainPolicy as Extract<typeof domainPolicy, { mode: 'delete_older_than' }>);
}

export function formatServerRetentionRows(policy: ServerRetentionPolicy | null | undefined): RetentionRow[] {
    if (!policy) return [];

    return SERVER_RETENTION_DOMAIN_METADATA.map(({ key, titleKey }) => ({
        key,
        title: t(titleKey),
        detail: formatDomainPolicyDetail({ policy, domainKey: key }),
    }));
}
