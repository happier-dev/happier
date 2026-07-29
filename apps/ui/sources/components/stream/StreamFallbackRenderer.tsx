import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

import { streamPlayerStyles } from './styles';

export function StreamFallbackRenderer(props: Readonly<{
    kind?: 'loading' | 'unavailable';
    reasonCode?: string;
    testID: string;
}>): React.ReactElement {
    const kind = props.kind ?? 'unavailable';
    return (
        <View testID={`${props.testID}-${kind}`} style={streamPlayerStyles.centered}>
            <Text style={streamPlayerStyles.titleText}>
                {kind === 'loading' ? t('streamPlayer.status.opening') : t('streamPlayer.status.unavailable')}
            </Text>
            {props.reasonCode ? (
                <Text
                    // Diagnostics-only: the raw reason code stays on the testID channel,
                    // never in visible product copy (audit SIM-4).
                    testID={`${props.testID}-${kind}-reason-${props.reasonCode}`}
                    style={streamPlayerStyles.metaText}
                >
                    {resolveReasonCopy({ reasonCode: props.reasonCode, kind: 'streamPlayer' }).body}
                </Text>
            ) : null}
        </View>
    );
}
