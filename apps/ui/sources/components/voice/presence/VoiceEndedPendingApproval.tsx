import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areSessionAddressesEqual, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import type { VoiceSessionEndedAttempt } from '@/voice/session/voiceSessionStore';

import { useSessionPendingPrompts } from './VoiceNeedsYouPrompts';
import { VoiceStatusCell } from './VoiceStatusCell';

/**
 * After End, a request the conversation left waiting (lab `voice-moments` NX "ended while pending"):
 * "Voice ended. Approval is still needed in Inbox." and Review request, which opens that exact session
 * where the real card decides it by a tap. Ending Voice decided nothing.
 *
 * Reads only the ended attempt's captured addresses (its bound coding target, then its conversation),
 * never a control id or the current route, and only while the ended attempt belongs to the Account
 * now on screen.
 */
export const VoiceEndedPendingApproval = React.memo(function VoiceEndedPendingApproval(props: Readonly<{
    ended: VoiceSessionEndedAttempt;
    testID: string;
}>): React.ReactElement | null {
    const currentScope = useActiveServerAccountScope();
    const { ended } = props;
    if (!ended.accountScope || !currentScope || !areServerAccountScopesEqual(ended.accountScope, currentScope)) return null;
    const addresses = [ended.targetSessionAddress, ended.conversationSessionAddress]
        .filter((address, index, all): address is SessionAddress => address !== null
            && all.findIndex((other) => other !== null && areSessionAddressesEqual(other, address)) === index);
    if (addresses.length === 0) return null;
    return (
        <>
            {addresses.map((address) => (
                <PendingForAddress key={`${address.serverId}/${address.sessionId}`} address={address} testID={props.testID} />
            ))}
        </>
    );
});

function PendingForAddress(props: Readonly<{ address: SessionAddress; testID: string }>) {
    const styles = stylesheet;
    const router = useRouter();
    const { prompts } = useSessionPendingPrompts(props.address);
    if (!prompts) return null;
    return (
        <View testID={props.testID} style={styles.row} accessibilityLiveRegion="polite">
            <VoiceStatusCell kind="needs_you" size={14} />
            <Text style={styles.line}>{t('voiceMoments.needsYouEnded')}</Text>
            <RoundButton
                testID={`${props.testID}.review`}
                size="small"
                display="secondary"
                title={t('voiceMoments.needsYouReview')}
                onPress={() => router.push(buildScopedSessionRouteHref({
                    sessionId: props.address.sessionId,
                    serverId: props.address.serverId,
                }) as never)}
            />
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
    },
    line: {
        ...Typography.default(),
        flexShrink: 1,
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
}));
