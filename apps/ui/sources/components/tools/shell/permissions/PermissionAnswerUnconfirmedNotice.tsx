import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { log } from '@/log';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { SessionTranscriptActions } from '@/components/sessions/transcript/source/types';
import { clearPermissionAnswerUnconfirmedAfterPendingRead } from './permissionActionFailure';

/**
 * The one presentation of "the answer may already be applied" for permission footers and question cards.
 * "Check again" reads the exact request through the source's scoped reader. A request still waiting releases
 * transport uncertainty; a provider submission remains withheld until settlement; a settled one is published by the source and ends with its card; when the read cannot tell,
 * the answer stays unconfirmed and the notice says so.
 */
export function PermissionAnswerUnconfirmedNotice(props: Readonly<{
    requestKey: string;
    requestId: string;
    actions: SessionTranscriptActions | null;
    testIDPrefix: string;
}>) {
    const { theme } = useUnistyles();
    const readOutcome = props.actions?.readRequestOutcome;
    const [checking, setChecking] = React.useState(false);
    const [couldNotCheck, setCouldNotCheck] = React.useState(false);
    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const checkAgain = async () => {
        if (!readOutcome || checking) return;
        setChecking(true);
        setCouldNotCheck(false);
        try {
            // A pending request resolves transport uncertainty, but a provider may still be applying a submitted answer.
            // Settled means the source already published the fresh Session; the card leaves the waiting
            // state with it, and the owning card ends the unconfirmed state then. Until it does, the
            // controls stay withheld, so a settled request is never offered another answer.
            if (await readOutcome(props.requestId) === 'pending') clearPermissionAnswerUnconfirmedAfterPendingRead(props.requestKey);
        } catch {
            log.log('[PermissionAnswerUnconfirmedNotice] request re-read failed');
            if (mounted.current) setCouldNotCheck(true);
        } finally {
            if (mounted.current) setChecking(false);
        }
    };

    return (
        <View
            testID={`${props.testIDPrefix}.answer-unconfirmed`}
            accessibilityRole="alert"
            style={styles.container}
        >
            <View style={styles.message}>
                <Icon name="clock" size={14} color={theme.colors.state.warning.foreground} />
                <Text style={styles.text}>
                    {couldNotCheck ? t('errors.permissionCheckAgainFailed') : t('errors.permissionAnswerUnconfirmed')}
                </Text>
            </View>
            {readOutcome ? (
                <RoundButton
                    testID={`${props.testIDPrefix}.check-again`}
                    size="mini"
                    display="secondary"
                    title={t('errors.permissionCheckAgain')}
                    loading={checking}
                    onPress={checkAgain}
                />
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s6,
        alignSelf: 'flex-start',
        maxWidth: '100%',
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s6,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.state.warning.border,
        backgroundColor: theme.colors.state.warning.background,
    },
    message: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s6,
        flexShrink: 1,
    },
    text: {
        color: theme.colors.state.warning.textForeground,
        fontSize: 12,
        flexShrink: 1,
    },
}));
