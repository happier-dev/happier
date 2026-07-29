import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

import { browserFrameStyles } from './styles';

const stylesheet = StyleSheet.create((theme) => ({
    action: {
        marginTop: 12,
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 8,
        backgroundColor: theme.colors.accent.indigo,
    },
    actionLabel: {
        color: theme.colors.button.primary.tint,
        fontWeight: '600',
    },
}));

/**
 * The non-framable web fallback (§3.4): shown when the engine's load-vs-timeout heuristic concludes
 * a site refuses embedding. The body message is sourced via the OWNER-COPY mapper
 * ({@link resolveReasonCopy}) so no raw reason code renders; the "open in system browser" action is
 * the fulfilled escape hatch ({@link openBrowserExternalTabSelection} → `openExternalUrl`), wired by
 * the caller. Never a silent blank/"No view".
 */
export function BrowserFrameNonFramable(props: Readonly<{
    testID: string;
    onOpenInSystemBrowser: () => void;
}>): React.ReactElement {
    const copy = resolveReasonCopy({ reasonCode: 'external_url_unavailable', kind: 'browserFrame' });
    return (
        <View testID={`${props.testID}-non-framable`} style={browserFrameStyles.centered}>
            <Text style={browserFrameStyles.statusText}>{t('browserShell.nonFramable.title')}</Text>
            <Text style={browserFrameStyles.statusText}>{copy.message}</Text>
            <Pressable
                testID={`${props.testID}-non-framable-open`}
                accessibilityRole="button"
                accessibilityLabel={t('browserShell.nonFramable.openInSystemBrowser')}
                onPress={props.onOpenInSystemBrowser}
                style={stylesheet.action}
            >
                <Text style={stylesheet.actionLabel}>{t('browserShell.nonFramable.openInSystemBrowser')}</Text>
            </Pressable>
        </View>
    );
}
