import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CopyIconButton } from '@/components/ui/copy/CopyIconButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';

/** The copy value's field is read-only; the field owner still takes a change handler. */
const READ_ONLY = () => {};

/** How to create a credential, as its declaration says; presentation only, the owner still validates it. */
export type ConnectedAccountGuideContent = Readonly<{
    consoleUrl: string;
    steps?: readonly string[];
    /** A one-line guide for a declaration without steps. */
    createKeyTitle?: string;
    /** What the credential must allow, per feature; listed under the steps, not numbered. */
    permissions?: readonly Readonly<{ feature: string; items: readonly string[] }>[];
    /** A value a step asks the person to paste at the provider (a redirect URL), offered to copy. */
    copyValue?: Readonly<{ label: string; value: string }>;
}>;

/**
 * The guide at the head of a credential form (lab crGuide): numbered steps on the sheet's one left edge,
 * the first being the link to the console (with no steps, that link is the line), then the permissions.
 */
export function ConnectedAccountGuide(props: Readonly<{ guide: ConnectedAccountGuideContent }>): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { guide } = props;
    const steps = guide.steps?.length ? guide.steps : guide.createKeyTitle ? [guide.createKeyTitle] : [];
    return (
        <View style={styles.guide} testID="connected-account-manual:guide">
            <View style={styles.steps} accessibilityRole="list">
                {(steps.length > 0 ? steps : [t('connectedServicesSettings.keyOpenConsole')]).map((step, index) => (
                    <View key={index} style={styles.step} testID={`connected-account-manual:step:${index}`}>
                        {steps.length > 1 ? <Text style={styles.stepNumber}>{index + 1}</Text> : null}
                        {index === 0 ? (
                            <Pressable testID="connected-account-manual:open-console" accessibilityRole="link" style={styles.stepLink}
                                onPress={() => openExternalUrl(guide.consoleUrl)}>
                                {/* Inline, so it stays with the sentence's last word when the sentence wraps. */}
                                <Text style={styles.link}>{step}{' '}<Icon name="arrow-square-out" size={12} color={theme.colors.text.secondary} /></Text>
                            </Pressable>
                        ) : <Text style={styles.stepText}>{step}</Text>}
                    </View>
                ))}
            </View>
            {guide.copyValue ? (
                <View style={styles.copy} testID="connected-account-manual:copy-value">
                    <Text style={styles.copyLabel}>{guide.copyValue.label}</Text>
                    {/* The field box owner, read-only: the value can be selected, and the button copies it. */}
                    <FieldTextInput value={guide.copyValue.value} onChangeText={READ_ONLY} editable={false} monospace accessibilityLabel={guide.copyValue.label}
                        testID="connected-account-manual:copy-value:field"
                        trailing={<CopyIconButton text={guide.copyValue.value} testID="connected-account-manual:copy-value:copy" />} />
                </View>
            ) : null}
            {guide.permissions?.length ? (
                <View style={styles.permissions} testID="connected-account-manual:permissions">
                    <Text style={styles.permissionsTitle}>{t('connectedServicesSettings.keyPermissionsTitle')}</Text>
                    {/* Checklist rows on the steps' columns: the glyph where the numbers sit, the feature, its items beneath. */}
                    {guide.permissions.map((entry, index) => (
                        <View key={index} style={styles.step} testID={`connected-account-manual:permission:${index}`}>
                            <View style={styles.permissionGlyph}>
                                <Icon name="check" size={12} color={theme.colors.text.tertiary} />
                            </View>
                            <View style={styles.permissionText}>
                                <Text style={styles.permissionFeature}>{entry.feature}</Text>
                                <Text style={styles.permissionItems}>{entry.items.join(' · ')}</Text>
                            </View>
                        </View>
                    ))}
                </View>
            ) : null}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    // With the next row's own inset, the bottom space matches the gap from the band above and between field rows.
    guide: { gap: theme.space.s16, paddingBottom: theme.space.s12 },
    steps: { gap: theme.space.s4 },
    step: { flexDirection: 'row', gap: theme.space.s8 },
    stepNumber: { ...Typography.variant('meta'), color: theme.colors.text.tertiary, minWidth: theme.space.s12, fontVariant: ['tabular-nums'] },
    stepText: { ...Typography.variant('meta'), color: theme.colors.text.secondary, flex: 1, minWidth: 0 },
    stepLink: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, flexShrink: 1 },
    link: { ...Typography.variant('meta'), color: theme.colors.text.primary, textDecorationLine: 'underline', flexShrink: 1 },
    permissions: { gap: theme.space.s6 },
    permissionsTitle: { ...Typography.variant('meta', 'medium'), color: theme.colors.text.primary },
    permissionGlyph: { minWidth: theme.space.s12, paddingTop: theme.space.s2 },
    permissionText: { flex: 1, minWidth: 0 },
    permissionFeature: { ...Typography.variant('meta', 'medium'), color: theme.colors.text.primary },
    permissionItems: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
    copy: { gap: theme.space.s4 },
    copyLabel: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
}));
