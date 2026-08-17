import { t } from '@/text';

import type { ServerRetentionPolicy } from './serverRetentionPolicy';
import { normalizeServerRetentionPolicy } from './serverRetentionPolicy';
import { getServerRetentionDomainMetadata } from './serverRetentionDomainMetadata';

type RetentionRow = Readonly<{
    key: string;
    title: string;
    detail: string;
}>;

function formatPolicy(policy: ReturnType<typeof normalizeServerRetentionPolicy>['domains'][number]['policy']): string {
    if (policy.mode === 'keep_forever') return t('server.retention.keepForever');
    if (policy.mode === 'delete_inactive') {
        return t('server.retention.deleteInactiveSessionsDays', { count: policy.inactivityDays });
    }
    return t('server.retention.deleteOlderThanDays', { count: policy.days });
}

export function formatSessionRetentionSummary(policy: ServerRetentionPolicy | null | undefined): string | null {
    if (!policy) return null;
    const view = normalizeServerRetentionPolicy(policy);
    if (!view.enabled) return t('server.retention.keepForever');
    const sessions = view.domains.find((domain) => domain.id === 'sessions')?.policy;
    if (sessions?.mode === 'delete_inactive') {
        return t('server.retention.sessionNotice', { count: sessions.inactivityDays });
    }
    if (view.domains.some(({ policy: domainPolicy }) => domainPolicy.mode !== 'keep_forever')) {
        return t('server.retention.automaticDeletionEnabled');
    }
    return view.completeness === 'complete'
        ? t('server.retention.keepForever')
        : t('server.retention.detailsUnavailable');
}

export function formatSavedServerRetentionSummary(policy: ServerRetentionPolicy | null | undefined): string | null {
    if (!policy) return null;
    const view = normalizeServerRetentionPolicy(policy);
    if (!view.enabled) return null;
    const finite = view.domains.find(({ policy: domainPolicy }) => domainPolicy.mode !== 'keep_forever');
    return finite ? formatPolicy(finite.policy) : null;
}

export function formatServerRetentionRows(policy: ServerRetentionPolicy | null | undefined): RetentionRow[] {
    if (!policy) return [];
    const view = normalizeServerRetentionPolicy(policy);
    return view.domains.map(({ id, policy: domainPolicy }) => ({
        key: id,
        title: getServerRetentionDomainMetadata(id)?.titleKey
            ? t(getServerRetentionDomainMetadata(id)!.titleKey)
            : id,
        detail: view.enabled ? formatPolicy(domainPolicy) : t('server.retention.keepForever'),
    }));
}

export function formatServerRetentionDisclosure(policy: ServerRetentionPolicy | null | undefined): string | null {
    if (!policy) return null;
    const view = normalizeServerRetentionPolicy(policy);
    if (!view.enabled) return null;
    const rowsById = new Map(formatServerRetentionRows(view).map((row) => [row.key, row]));
    const policies = view.domains.flatMap((domain) => {
        if (domain.policy.mode === 'keep_forever') return [];
        if (domain.id === 'sessions' && domain.policy.mode === 'delete_inactive') {
            return [t('server.retention.relayCleanupInactiveSessionsAfterDays', {
                count: domain.policy.inactivityDays,
            })];
        }
        if (domain.policy.mode !== 'delete_older_than') return [];
        const title = rowsById.get(domain.id)?.title ?? domain.id;
        const firstCharacter = Array.from(title)[0] ?? '';
        const sentenceCaseTitle = firstCharacter
            ? `${firstCharacter.toLocaleLowerCase()}${title.slice(firstCharacter.length)}`
            : title;
        return [t('server.retention.relayCleanupAfterDays', {
            domain: sentenceCaseTitle,
            count: domain.policy.days,
        })];
    });
    if (policies.length === 0) return null;
    return t('server.retention.relayCleanupSummary', { policies: policies.join(', ') });
}
