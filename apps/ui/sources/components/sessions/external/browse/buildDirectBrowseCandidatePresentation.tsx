import * as React from 'react';
import { View } from 'react-native';
import type { DirectSessionActivityV1 } from '@happier-dev/protocol';

import type { ResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { lightTheme } from '@/theme';
import { t } from '@/text';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

type AppTheme = typeof lightTheme;

type DirectBrowseCandidate = Readonly<{
    remoteSessionId: string;
    title?: string;
    updatedAtMs: number;
    activity?: DirectSessionActivityV1;
    details?: Record<string, unknown>;
}>;

export function readDirectBrowseCandidatePath(details: Record<string, unknown> | undefined): string | null {
    const cwd = typeof details?.cwd === 'string' ? details.cwd.trim() : '';
    if (cwd) return cwd;
    const path = typeof details?.path === 'string' ? details.path.trim() : '';
    return path || null;
}

function normalizeCandidateTitle(candidate: DirectBrowseCandidate): string | null {
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
    if (!title || title === candidate.remoteSessionId) return null;
    return title;
}

export function formatDirectBrowseCandidatePathLabel(path: string | null): string | null {
    const normalizedPath = typeof path === 'string' ? path.replace(/\\/g, '/').trim() : '';
    if (!normalizedPath) return null;
    return normalizedPath;
}

export function buildDirectBrowseCandidateDisplayTitle(candidate: DirectBrowseCandidate): string {
    const candidateTitle = normalizeCandidateTitle(candidate);
    if (candidateTitle) return candidateTitle;

    const pathLabel = formatDirectBrowseCandidatePathLabel(readDirectBrowseCandidatePath(candidate.details));
    if (pathLabel) return pathLabel.split('/').filter(Boolean).at(-1) ?? pathLabel;

    return candidate.remoteSessionId;
}

function buildDirectBrowseCandidatePrimaryMeta(candidate: DirectBrowseCandidate): string | null {
    if (candidate.activity === 'running') {
        return t('directSessions.browseActivityRunningNow');
    }

    if (candidate.updatedAtMs > 0) {
        const shortRelativeTime = formatShortRelativeTime(candidate.updatedAtMs);
        if (shortRelativeTime) {
            return shortRelativeTime === 'now' ? 'now' : `${shortRelativeTime} ago`;
        }
    }

    return null;
}

export function buildDirectBrowseCandidateSubtitle(
    candidate: DirectBrowseCandidate,
    theme: AppTheme,
    density: ResolvedItemDensity,
): React.ReactNode {
    const pathLabel = formatDirectBrowseCandidatePathLabel(readDirectBrowseCandidatePath(candidate.details));
    const meaningfulTitle = normalizeCandidateTitle(candidate);
    const subtitleMetrics = ITEM_SUBTITLE_TEXT_METRICS[density];
    const subtitleTextStyle = {
        ...Typography.default('regular'),
        ...subtitleMetrics,
    } as const;
    const primaryMeta = buildDirectBrowseCandidatePrimaryMeta(candidate);
    const secondaryLine = pathLabel ?? (!meaningfulTitle ? candidate.remoteSessionId : null);

    return (
        <Text style={subtitleTextStyle} numberOfLines={1}>
            {primaryMeta ? (
                <Text
                    style={[
                        subtitleTextStyle,
                        {
                            color: theme.colors.textSecondary,
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
                            color: theme.colors.textSecondary,
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
                            color: theme.colors.textTertiary,
                        },
                    ]}
                >
                    {secondaryLine}
                </Text>
            ) : null}
        </Text>
    );
}

export function buildDirectBrowseCandidateSearchValue(candidate: DirectBrowseCandidate): string {
    const path = readDirectBrowseCandidatePath(candidate.details);

    return [
        buildDirectBrowseCandidateDisplayTitle(candidate),
        typeof candidate.title === 'string' ? candidate.title : '',
        candidate.remoteSessionId,
        path ?? '',
    ]
        .join('\n')
        .toLowerCase();
}

export function buildDirectBrowseCandidateRightElement(
    candidate: DirectBrowseCandidate,
    theme: AppTheme,
    density: ResolvedItemDensity,
): React.ReactNode {
    const badge = (() => {
        switch (candidate.activity) {
            case 'running':
                return {
                    color: theme.colors.success,
                    label: t('directSessions.browseActivityRunning'),
                    pulsing: true,
                };
            case 'active_recently':
                return {
                    color: theme.colors.accent.orange,
                    label: t('directSessions.browseActivityRecent'),
                    pulsing: false,
                };
            case 'idle':
                return {
                    color: theme.colors.textSecondary,
                    label: t('directSessions.browseActivityIdle'),
                    pulsing: false,
                };
            case 'unknown':
                return {
                    color: theme.colors.textSecondary,
                    label: t('directSessions.browseActivityUnknown'),
                    pulsing: false,
                };
            default:
                return null;
        }
    })();

    if (!badge) return null;
    return (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                borderRadius: 999,
                backgroundColor: theme.colors.surfaceHigh,
                paddingHorizontal: 7,
                paddingVertical: 3,
            }}
        >
            <StatusDot color={badge.color} isPulsing={badge.pulsing} size={7} />
            <Text
                style={{
                    color: badge.color,
                    ...Typography.default('semiBold'),
                    ...ITEM_SUBTITLE_TEXT_METRICS[density],
                }}
            >
                {badge.label}
            </Text>
        </View>
    );
}
