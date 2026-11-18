import * as React from 'react';
import { View } from 'react-native';

import { useDetailsTabHeaderActionsCompact } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { Text } from '@/components/ui/text/Text';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { ExternalSessionRuntimePresentation } from '../../presentation/externalSessionRuntimePresentation';

/**
 * The external Agent's live state in a Session's header chrome: the Session page header and the peek header that
 * stands in for it when the Session is embedded. No current evidence about the external Agent shows nothing rather
 * than an "unknown" chip.
 */
export const SessionHeaderExternalAgentStatus = React.memo(function SessionHeaderExternalAgentStatus(props: Readonly<{
    sessionId: string;
    externalAgent: ExternalSessionRuntimePresentation['externalAgent'] | null | undefined;
    color: string;
}>) {
    const externalAgent = props.externalAgent;
    if (!externalAgent || externalAgent.state === 'unknown') return null;
    return (
        <View
            testID={`session-header-external-agent-status-${externalAgent.state}`}
            accessibilityLabel={t(externalAgent.labelKey)}
            style={{
                maxWidth: 160,
                marginRight: 4,
                paddingHorizontal: 6,
                paddingVertical: 4,
                borderRadius: 999,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 3,
            }}
        >
            <WorkStatusGlyph
                status={resolveWorkStatusTone({ kind: 'external_agent', facts: {
                    externalAgent,
                    word: t(externalAgent.labelKey),
                } })}
                testIDSuffix={`${props.sessionId}-header-external`}
            />
            <HeaderChipLabel>
                <Text
                    numberOfLines={1}
                    style={{
                        color: props.color,
                        ...Typography.variant('meta', 'semiBold'),
                    }}
                >
                    {t(externalAgent.labelKey)}
                </Text>
            </HeaderChipLabel>
        </View>
    );
});

/** A header chip's words, left out while the header is tight; its accessible label and mark stay. */
function HeaderChipLabel(props: Readonly<{ children: React.ReactNode }>): React.ReactElement | null {
    return useDetailsTabHeaderActionsCompact() ? null : <>{props.children}</>;
}
