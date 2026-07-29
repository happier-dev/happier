import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { LiveStreamPlayerPhase } from '@/sync/domains/machines/peer/mediation/stream/player';

import { StreamStatusDot, resolveStreamStatusDotVariant } from './StreamStatusDot';
import { streamPlayerStyles } from './styles';

function resolveStatusLabel(phase: LiveStreamPlayerPhase, reasonCode?: string): string {
    if (reasonCode === 'input_lease_expired') return t('streamPlayer.status.leaseExpired');
    if (reasonCode === 'permission_expired') return t('streamPlayer.status.permissionExpired');
    if (reasonCode === 'slow_consumer') return t('streamPlayer.status.lowBandwidth');
    if (reasonCode === 'preferred_codec_unavailable' || reasonCode === 'h264_renderer_unavailable') {
        return t('streamPlayer.status.degradedCodec');
    }

    switch (phase) {
        case 'opening':
            return t('streamPlayer.status.opening');
        case 'playing':
            return t('streamPlayer.status.playing');
        case 'degraded':
            return t('streamPlayer.status.degraded');
        case 'reconnecting':
            return t('streamPlayer.status.reconnecting');
        case 'error':
            return t('streamPlayer.status.errorGeneric');
        case 'stopped':
            return t('streamPlayer.status.stopped');
        case 'idle':
            return t('streamPlayer.status.unavailable');
    }
}

function resolveStatusTestId(phase: LiveStreamPlayerPhase, reasonCode?: string): string {
    if (reasonCode === 'slow_consumer') return 'low-bandwidth';
    if (phase === 'degraded') return 'degraded';
    if (phase === 'reconnecting') return 'reconnecting';
    if (phase === 'error') return 'error';
    if (phase === 'opening') return 'opening';
    if (phase === 'stopped') return 'stopped';
    return 'playing';
}

export function StreamDiagnosticsOverlay(props: Readonly<{
    phase: LiveStreamPlayerPhase;
    reasonCode?: string;
    preservingLastFrame: boolean;
    testID: string;
}>): React.ReactElement {
    const statusId = resolveStatusTestId(props.phase, props.reasonCode);
    return (
        <View style={streamPlayerStyles.overlay}>
            <View testID={`${props.testID}-status-${statusId}`} style={streamPlayerStyles.statusPillRow}>
                <StreamStatusDot
                    variant={resolveStreamStatusDotVariant(props.phase, props.reasonCode)}
                    testID={`${props.testID}-status-dot`}
                />
                <Text style={streamPlayerStyles.statusText}>
                    {resolveStatusLabel(props.phase, props.reasonCode)}
                </Text>
            </View>
            {props.preservingLastFrame ? (
                <View testID={`${props.testID}-last-frame`} style={streamPlayerStyles.statusPill}>
                    <Text style={streamPlayerStyles.statusText}>{t('streamPlayer.status.preservingLastFrame')}</Text>
                </View>
            ) : null}
        </View>
    );
}
