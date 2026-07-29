import * as React from 'react';
import { View } from 'react-native';
import type { ExternalSessionActivityV1 } from '@happier-dev/protocol';

import type { ResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { StatusPill, type StatusPillVariant } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { formatRelativeTimeShort } from '@/components/ui/selectionList/formatRelativeTimeShort';
import { Typography } from '@/constants/Typography';
import { resolveExternalSessionCandidateActivityPresentation } from '@/components/sessions/presentation/externalSessionRuntimePresentation';
import type { Theme } from '@/theme';
import { t } from '@/text';

type AppTheme = Theme;

type ExternalSessionBrowseCandidate = Readonly<{
    remoteSessionId: string;
    title?: string;
    updatedAtMs: number;
    activity?: ExternalSessionActivityV1;
    details?: Record<string, unknown>;
    linkedSessionId?: string;
    imported?: boolean;
    materializedThrough?: number;
}>;

export function readExternalSessionBrowseCandidatePath(details: Record<string, unknown> | undefined): string | null {
    const cwd = typeof details?.cwd === 'string' ? details.cwd.trim() : '';
    if (cwd) return cwd;
    const path = typeof details?.path === 'string' ? details.path.trim() : '';
    return path || null;
}

function normalizeCandidateTitle(candidate: ExternalSessionBrowseCandidate): string | null {
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
    if (!title || title === candidate.remoteSessionId) return null;
    return title;
}

export function formatExternalSessionBrowseCandidatePathLabel(path: string | null): string | null {
    const normalizedPath = typeof path === 'string' ? path.replace(/\\/g, '/').trim() : '';
    if (!normalizedPath) return null;
    return normalizedPath;
}

export function buildExternalSessionBrowseCandidateDisplayTitle(candidate: ExternalSessionBrowseCandidate): string {
    const candidateTitle = normalizeCandidateTitle(candidate);
    if (candidateTitle) return candidateTitle;

    const pathLabel = formatExternalSessionBrowseCandidatePathLabel(readExternalSessionBrowseCandidatePath(candidate.details));
    if (pathLabel) return pathLabel.split('/').filter(Boolean).at(-1) ?? pathLabel;

    return candidate.remoteSessionId;
}

function buildExternalSessionBrowseCandidatePrimaryMeta(candidate: ExternalSessionBrowseCandidate): string | null {
    if (candidate.activity === 'running') {
        return t('externalSessions.browseActivityRunningNow');
    }

    if (candidate.updatedAtMs > 0) {
        return formatRelativeTimeShort(candidate.updatedAtMs, Date.now());
    }

    return null;
}

export function buildExternalSessionBrowseCandidateSubtitle(
    candidate: ExternalSessionBrowseCandidate,
    theme: AppTheme,
    density: ResolvedItemDensity,
    context?: Readonly<{
        agentLabel?: string | null;
        machineLabel?: string | null;
    }>,
): React.ReactNode {
    const pathLabel = formatExternalSessionBrowseCandidatePathLabel(readExternalSessionBrowseCandidatePath(candidate.details));
    const meaningfulTitle = normalizeCandidateTitle(candidate);
    const subtitleMetrics = ITEM_SUBTITLE_TEXT_METRICS[density];
    const subtitleTextStyle = {
        ...Typography.default('regular'),
        ...subtitleMetrics,
    } as const;
    const primaryMeta = buildExternalSessionBrowseCandidatePrimaryMeta(candidate);
    const pathOrIdentity = pathLabel ?? (!meaningfulTitle ? candidate.remoteSessionId : null);
    const secondaryLine = [
        context?.agentLabel,
        context?.machineLabel,
        pathOrIdentity,
    ].filter(Boolean).join(' · ') || null;

    return (
        <Text style={subtitleTextStyle} numberOfLines={1}>
            {primaryMeta ? (
                <Text
                    style={[
                        subtitleTextStyle,
                        {
                            color: theme.colors.text.secondary,
                        },
                    ]}
                >
                    {primaryMeta}
                </Text>
            ) : null}
            {primaryMeta && secondaryLine ? (
                <Text
                    style={[
                        subtitleTextStyle,
                        {
                            color: theme.colors.text.secondary,
                        },
                    ]}
                >
                    {' · '}
                </Text>
            ) : null}
            {secondaryLine ? (
                <Text
                    style={[
                        subtitleTextStyle,
                        {
                            color: theme.colors.text.tertiary,
                        },
                    ]}
                >
                    {secondaryLine}
                </Text>
            ) : null}
        </Text>
    );
}

export function buildExternalSessionBrowseCandidateRightElement(
    candidate: ExternalSessionBrowseCandidate,
    _theme: AppTheme,
    _density: ResolvedItemDensity,
): React.ReactNode {
    const presentation = resolveExternalSessionCandidateActivityPresentation(candidate.activity);
    const statusVariant: StatusPillVariant = presentation.tone === 'live' || presentation.tone === 'ready'
        ? 'success'
        : presentation.tone === 'attention' || presentation.tone === 'warning'
            ? 'warning'
            : 'neutral';
    const hasStatus = candidate.activity !== undefined;
    if (!hasStatus && !candidate.linkedSessionId && !candidate.imported) return null;
    return (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'wrap',
                justifyContent: 'flex-end',
            }}
        >
            {hasStatus ? (
                <StatusPill
                    variant={statusVariant}
                    label={t(presentation.labelKey)}
                    isPulsing={presentation.indicator === 'working'}
                    testID={`external-session-candidate-status:${candidate.remoteSessionId}`}
                />
            ) : null}
            {candidate.linkedSessionId ? (
                <StatusPill
                    variant="neutral"
                    label={t('externalSessions.browseLinked')}
                    hideDot
                    testID={`external-session-candidate-linked:${candidate.remoteSessionId}`}
                />
            ) : null}
            {candidate.imported ? (
                <StatusPill
                    variant="info"
                    label={t('externalSessions.browseImported')}
                    hideDot
                    testID={`external-session-candidate-imported:${candidate.remoteSessionId}`}
                />
            ) : null}
        </View>
    );
}
