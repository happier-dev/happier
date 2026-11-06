import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

export type ReportedModelStatus = 'running' | 'last_used' | 'last_reported';

/**
 * How live "this is what the Session actually uses" is, from the Session's own
 * activity.
 *
 * Extracted here because two surfaces ask it of the same Session: the model list,
 * for the applied model, and the composer's Agent rail, for the Agent running the
 * Session. They are two columns of ONE popover, so a second reading would let them
 * disagree in a single glance.
 */
export function resolveReportedModelStatus(
    sessionActive: boolean | null | undefined,
): ReportedModelStatus {
    if (sessionActive === true) return 'running';
    if (sessionActive === false) return 'last_used';
    return 'last_reported';
}

export function reportedModelIconName(
    status: ReportedModelStatus,
): IconName {
    switch (status) {
        case 'running':
            return 'play-circle';
        case 'last_used':
            return 'clock';
        case 'last_reported':
            return 'info';
    }
}

export function reportedModelSummary(status: ReportedModelStatus, modelLabel: string): string {
    switch (status) {
        case 'running':
            return t('agentInput.model.running', { model: modelLabel });
        case 'last_used':
            return t('agentInput.model.lastUsed', { model: modelLabel });
        case 'last_reported':
            return t('agentInput.model.lastReported', { model: modelLabel });
    }
}

export function ReportedModelSummary(props: Readonly<{
    status: ReportedModelStatus;
    modelLabel: string;
    /** When a change takes effect ("Applies from your next message"), on the same line. */
    applyTiming?: string;
}>) {
    return (
        <Text style={styles.label}>
            {reportedModelSummary(props.status, props.modelLabel)}
            {props.applyTiming ? ` · ${props.applyTiming}` : null}
        </Text>
    );
}

export function ReportedModelStatusIcon(props: Readonly<{
    status: ReportedModelStatus;
    /**
     * Defaults to the model list's 16. The Agent rail passes 14 because there the
     * mark stands IN the checkmark's slot rather than beside a roomier row, so it
     * is the checkmark's size.
     */
    size?: number;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    return (
        <Icon
            name={reportedModelIconName(props.status)}
            size={props.size ?? 16}
            color={theme.colors.text.secondary}
            testID={props.testID}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    label: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
}));
