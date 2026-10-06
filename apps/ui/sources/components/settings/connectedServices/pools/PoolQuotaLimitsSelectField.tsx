import * as React from 'react';

import type { ConnectedServiceQuotaLimitSelectionV1 } from '@happier-dev/protocol';

import { getPreferredLanguage, t } from '@/text';

import { MultiSelectField } from '@/components/ui/forms/dropdown/MultiSelectField';

export type PoolQuotaLimitCandidate = Readonly<{
    providerLimitId: string;
    title: string;
    modelIds: readonly string[];
    windowCount: number;
    windowSummary: string | null;
    reportingMemberCount: number;
    enabledMemberCount: number;
    technicalId?: string;
    unavailable?: boolean;
}>;

export type PoolQuotaLimitsSelectFieldProps = Readonly<{
    candidates: ReadonlyArray<PoolQuotaLimitCandidate>;
    selection: ConnectedServiceQuotaLimitSelectionV1 | undefined;
    onCommit: (selection: ConnectedServiceQuotaLimitSelectionV1) => void;
    disabled?: boolean;
    loadingMemberCount?: number;
    testID?: string;
}>;

// Whitespace cannot collide with a provider limit id because the wire schema trims and rejects it.
// The sentinel stays local to this menu and is never persisted.
const ALL_LIMITS_ID = ' ';

function buildQuotaLimitCandidateSubtitle(candidate: PoolQuotaLimitCandidate): string {
    const parts: string[] = [];
    if (candidate.unavailable) {
        parts.push(t('connectedServices.detail.groupDetail.quotaLimitUnavailableSubtitle'));
    }
    if (candidate.technicalId) {
        parts.push(t('connectedServices.detail.groupDetail.quotaLimitTechnicalIdSubtitle', {
            providerLimitId: candidate.technicalId,
        }));
    }
    if (candidate.modelIds.length === 1) {
        parts.push(t('connectedServices.detail.groupDetail.quotaLimitModelSubtitle', {
            modelId: candidate.modelIds[0],
        }));
    } else if (candidate.modelIds.length > 1) {
        parts.push(t('connectedServices.detail.groupDetail.quotaLimitModelsSubtitle', {
            count: candidate.modelIds.length,
        }));
    }
    if (candidate.windowSummary) {
        parts.push(candidate.windowSummary);
    } else if (candidate.windowCount > 1) {
        parts.push(t('connectedServices.detail.groupDetail.quotaLimitWindowsSubtitle', {
            count: candidate.windowCount,
        }));
    }
    if (candidate.enabledMemberCount > 0) {
        parts.push(t('connectedServices.detail.groupDetail.quotaLimitReportingSubtitle', {
            reporting: candidate.reportingMemberCount,
            total: candidate.enabledMemberCount,
        }));
    }
    return parts.join(' · ');
}

export const PoolQuotaLimitsSelectField = React.memo(function PoolQuotaLimitsSelectField(
    props: PoolQuotaLimitsSelectFieldProps,
) {
    const committed = props.selection ?? { mode: 'all' as const, providerLimitIds: [] };
    const locale = getPreferredLanguage();
    const candidates = React.useMemo(() => [
        {
            id: ALL_LIMITS_ID,
            title: t('connectedServices.detail.groupDetail.quotaLimitsAllTitle'),
            subtitle: props.loadingMemberCount && props.loadingMemberCount > 0
                ? t('connectedServices.detail.groupDetail.quotaLimitsAllLoadingSubtitle', {
                    count: props.loadingMemberCount,
                })
                : t('connectedServices.detail.groupDetail.quotaLimitsAllSubtitle'),
        },
        ...props.candidates.map((candidate) => ({
            id: candidate.providerLimitId,
            title: candidate.title,
            subtitle: buildQuotaLimitCandidateSubtitle(candidate) || undefined,
        })),
    ], [locale, props.candidates, props.loadingMemberCount]);
    const selectedIds = committed.mode === 'selected'
        ? committed.providerLimitIds
        : [ALL_LIMITS_ID];

    return (
        <MultiSelectField
            candidates={candidates}
            selectedIds={selectedIds}
            onCommit={(ids) => props.onCommit(ids.includes(ALL_LIMITS_ID)
                ? { mode: 'all', providerLimitIds: [] }
                : { mode: 'selected', providerLimitIds: [...ids] })}
            title={t('connectedServices.detail.groupDetail.quotaLimitsTitle')}
            subtitle={(count, _total, selected) => selected.has(ALL_LIMITS_ID)
                ? t('connectedServices.detail.groupDetail.quotaLimitsAllTitle')
                : t('connectedServices.detail.groupDetail.quotaLimitsSelectedSubtitle', { count })}
            emptySubtitle={t('connectedServices.detail.groupDetail.quotaLimitsAllTitle')}
            searchPlaceholder={t('connectedServices.detail.groupDetail.quotaLimitsSearchPlaceholder')}
            optionTestIDPrefix="qualified-connected-account-group:quota-limits:option"
            disabled={props.disabled}
            minimumSelected={1}
            exclusiveId={ALL_LIMITS_ID}
            testID={props.testID}
        />
    );
});
