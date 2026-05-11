import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { getActionSpec, resolveEffectiveActionInputFields, type ActionId } from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { formatApprovalFieldValues, getApprovalFieldValues, shouldHideApprovalField } from './approvalFieldValues';

export const ActionApprovalFieldsCard = React.memo(function ActionApprovalFieldsCard(props: Readonly<{
    actionId: string;
    actionArgs: unknown;
}>) {
    const spec = React.useMemo(() => {
        try {
            return getActionSpec(props.actionId as ActionId);
        } catch {
            return null;
        }
    }, [props.actionId]);

    const fields = React.useMemo(() => {
        if (!spec) return [];
        const resolved = resolveEffectiveActionInputFields(spec, props.actionArgs);
        const paths = resolved.map((field) => field.path);
        return resolved.filter((field) => !shouldHideApprovalField(field.path, paths));
    }, [props.actionArgs, spec]);

    const rows = React.useMemo(() => {
        return fields.flatMap((field) => {
            const value = formatApprovalFieldValues(getApprovalFieldValues(props.actionArgs, field.path));
            if (!value) return [];
            return [{ key: field.path, title: field.title, value }];
        });
    }, [fields, props.actionArgs]);

    if (!spec || rows.length === 0) return null;

    return (
        <View style={styles.card}>
            <Text style={styles.sectionTitle}>{t('approvals.details')}</Text>
            <View style={styles.rows}>
                {rows.map((row) => (
                    <View key={row.key} style={styles.row}>
                        <Text style={styles.label}>{row.title}</Text>
                        <Text style={styles.value}>{row.value}</Text>
                    </View>
                ))}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    card: {
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        padding: 16,
        gap: 12,
    },
    sectionTitle: {
        fontSize: 14,
        fontWeight: '700',
        color: theme.colors.text.primary,
    },
    rows: {
        gap: 10,
    },
    row: {
        gap: 4,
    },
    label: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontWeight: '600',
    },
    value: {
        fontSize: 14,
        color: theme.colors.text.primary,
        lineHeight: 20,
    },
}));
