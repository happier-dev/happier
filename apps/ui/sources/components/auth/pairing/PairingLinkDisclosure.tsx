import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';

const stylesheet = StyleSheet.create((theme) => ({
    disclosure: {
        width: '100%',
        marginTop: theme.space.s8,
    },
    header: {
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s10,
        justifyContent: 'center',
        borderRadius: 10,
    },
    headerPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    headerTitle: {
        color: theme.colors.text.primary,
    },
    headerSubtitle: {
        marginTop: theme.space.s2,
        color: theme.colors.text.secondary,
    },
    body: {
        width: '100%',
        paddingHorizontal: theme.space.s16,
        paddingBottom: 14,
    },
    warning: {
        color: theme.colors.text.secondary,
        lineHeight: 18,
    },
    link: {
        marginTop: theme.space.s10,
        color: theme.colors.text.secondary,
        lineHeight: 18,
    },
    actions: {
        marginTop: theme.space.s12,
        alignItems: 'flex-start',
        gap: theme.space.s8,
    },
}));

export const PairingLinkDisclosure = React.memo(function PairingLinkDisclosure(props: Readonly<{
    testIDPrefix: string;
    link?: string;
    children?: React.ReactNode;
}>) {
    const styles = stylesheet;
    const [expanded, setExpanded] = React.useState(false);
    const writeClipboard = useClipboardWrite(undefined, { enabled: expanded });
    const copyFeedback = useHappierCopyFeedback();

    return (
        <View testID={`${props.testIDPrefix}-disclosure`} style={styles.disclosure}>
            <HappierPressable
                testID={`${props.testIDPrefix}-details`}
                accessibilityRole="button"
                expanded={expanded}
                accessibilityLabel={`${t('common.details')}. ${t('connect.showPairingLink')}`}
                onPress={() => setExpanded((current) => !current)}
                style={(state) => [styles.header, state.pressed ? styles.headerPressed : null]}
            >
                <Text style={styles.headerTitle}>{t('common.details')}</Text>
                <Text style={styles.headerSubtitle}>{t('connect.showPairingLink')}</Text>
            </HappierPressable>
            {expanded ? <View testID={props.testIDPrefix} style={styles.body}>
                <Text style={styles.warning}>{t('connect.pairingLinkSecurityWarning')}</Text>
                {props.link ? (
                    <Text testID={`${props.testIDPrefix}-value`} style={styles.link} selectable>
                        {props.link}
                    </Text>
                ) : null}
                <View style={styles.actions}>
                    {props.link ? (
                        <>
                            <RoundButton
                                testID={`${props.testIDPrefix}-copy`}
                                size="small"
                                title={t('common.copy')}
                                display="inverted"
                                action={async () => {
                                    const copied = await writeClipboard(props.link!);
                                    if (!copied) {
                                        await Modal.alertAsync(t('common.error'), t('items.failedToCopyToClipboard'));
                                        return;
                                    }
                                    copyFeedback.markCopied();
                                }}
                            />
                            <CopiedPill
                                visible={copyFeedback.isCopied()}
                                testID={`${props.testIDPrefix}-copy-feedback`}
                            />
                        </>
                    ) : null}
                    {props.children}
                </View>
            </View> : null}
        </View>
    );
});
