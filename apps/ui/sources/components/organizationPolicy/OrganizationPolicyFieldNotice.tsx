import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type { OrganizationPolicyField, OrganizationPolicyLock } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useOpenExternalUrl } from '@/hooks/ui/useOpenExternalUrl';
import { getOrganizationPolicyFieldLock, readOrganizationPolicy } from '@/sync/domains/organizationPolicy/organizationPolicy';
import { t } from '@/text';

/** Presentation of the startup policy owner's result; mutation admission remains with the domain. */
export function readOrganizationPolicyFieldState(field: OrganizationPolicyField): Readonly<{
    disabled: boolean;
    accessibilityHint: string | undefined;
    lock: OrganizationPolicyLock | null;
}> {
    const result = readOrganizationPolicy();
    const lock = getOrganizationPolicyFieldLock(field);
    const accessibilityHint = result.status === 'invalid'
        ? t('organizationPolicy.invalidBody')
        : lock ? `${t('organizationPolicy.managedBy', { organization: lock.organization })}. ${t('organizationPolicy.lockedExplanation')}` : undefined;
    return { disabled: result.status === 'invalid' || lock !== null, accessibilityHint, lock };
}

export function OrganizationPolicyFieldNotice(props: Readonly<{ field: OrganizationPolicyField }>) {
    const state = readOrganizationPolicyFieldState(props.field);
    if (!state.lock) return null;
    return (
        <View testID={`organization-policy-${props.field}`} style={styles.notice}>
            <Text style={styles.title}>{t('organizationPolicy.managedBy', { organization: state.lock.organization })}</Text>
            <Text style={styles.explanation}>{t('organizationPolicy.lockedExplanation')}</Text>
            {state.lock?.supportUrl ? <SupportLink url={state.lock.supportUrl} testID={`organization-policy-${props.field}-support`} /> : null}
        </View>
    );
}

function SupportLink(props: Readonly<{ url: string; testID: string }>) {
    const [, open] = useOpenExternalUrl(props.url);
    return (
        <HappierPressable testID={props.testID} accessibilityRole="link" accessibilityLabel={t('organizationPolicy.support')} onPress={open}>
            <Text style={styles.support}>{t('organizationPolicy.support')}</Text>
        </HappierPressable>
    );
}

/** A broken native policy affects governed actions, while the rest of the app stays usable. */
export function OrganizationPolicyDiagnostic() {
    const result = readOrganizationPolicy();
    if (result.status !== 'invalid') return null;
    return <AttentionBanner testID="organization-policy-invalid" presentation="strip" placement="inline" tone="danger" announce="alert"
        title={t('organizationPolicy.invalidTitle')} description={t('organizationPolicy.invalidBody')}
        details={[`${result.error.path}: ${result.error.code}`]} />;
}

const styles = StyleSheet.create((theme) => ({
    notice: { gap: theme.space.s4 },
    title: { ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.primary },
    explanation: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
    support: { ...Typography.variant('meta', 'medium'), color: theme.colors.text.primary, textDecorationLine: 'underline' },
}));
