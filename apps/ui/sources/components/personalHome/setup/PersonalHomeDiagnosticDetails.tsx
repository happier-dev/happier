import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SystemTaskProgressCard } from '@/components/systemTasks/SystemTaskProgressCard';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { CopyIconButton } from '@/components/ui/copy/CopyIconButton';
import { DisclosedCodeText } from '@/components/ui/lists/DisclosureCaret';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { NormalizedSetupDetail } from '../bootstrap/personalHomeBootstrapTypes';

const styles = StyleSheet.create((theme) => ({
    root: { gap: theme.space.s10, alignSelf: 'stretch' },
    centered: { alignItems: 'center' },
    message: { color: theme.colors.text.secondary, ...Typography.variant('body') },
    messageCentered: { textAlign: 'center' },
    codeRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
}));

const SENSITIVE_ASSIGNMENT = /\b(authorization(?!\s*[:=]?\s*bearer\b)|bearer|token|seed|secret|password|credential|api[-_]?key)\b(\s*[:=]\s*)([^\s;,]+)/gi;
const BEARER_VALUE = /\bauthorization\s*[:=]?\s*bearer\s+[^\s;,]+/gi;
const HIGH_ENTROPY_VALUE = /\b(?:[a-f0-9]{32,}|[A-Za-z0-9_-]{40,}={0,2})\b/g;

export function sanitizePersonalHomeDiagnosticMessage(message: string): string {
    return message
        .replace(BEARER_VALUE, 'Authorization: Bearer [redacted]')
        .replace(SENSITIVE_ASSIGNMENT, (_match, label: string, separator: string) => `${label}${separator}[redacted]`)
        .replace(HIGH_ENTROPY_VALUE, '[redacted]');
}

function sanitizeTaskSnapshot(snapshot: SystemTaskRunState): SystemTaskRunState {
    return {
        ...snapshot,
        latestMessage: snapshot.latestMessage == null
            ? null
            : sanitizePersonalHomeDiagnosticMessage(snapshot.latestMessage),
        currentStepId: snapshot.currentStepId == null
            ? null
            : sanitizePersonalHomeDiagnosticMessage(snapshot.currentStepId),
        events: snapshot.events.map((event) => ({
            ...event,
            ...(event.stepId ? { stepId: sanitizePersonalHomeDiagnosticMessage(event.stepId) } : {}),
            ...(event.message ? { message: sanitizePersonalHomeDiagnosticMessage(event.message) } : {}),
            // Prompt payloads can contain temporary URLs or credentials. The Personal Home
            // disclosure needs progress diagnostics, not actionable secret-bearing payloads.
            data: undefined,
        })),
        result: null,
    };
}

/**
 * What a Details disclosure reveals about Personal Home setup: the failure in the runtime's own words
 * first, then its reason code small and secondary with a copy button for support, then the task's
 * progress. The message is left out when it repeats the sentence already on screen (`shownSummary`).
 */
export const PersonalHomeDiagnosticDetails = React.memo(function PersonalHomeDiagnosticDetails(props: Readonly<{
    detail?: NormalizedSetupDetail;
    activeTask?: SystemTaskRunState | null;
    /** The sentence the surface already shows; a diagnostic message equal to it is not repeated. */
    shownSummary?: string;
    /** On a centred surface the words centre on its axis. */
    align?: 'center';
}>) {
    const task = React.useMemo(
        () => props.activeTask ? sanitizeTaskSnapshot(props.activeTask) : null,
        [props.activeTask],
    );
    const code = props.detail?.code ? sanitizePersonalHomeDiagnosticMessage(props.detail.code) : null;
    const message = props.detail?.message ? sanitizePersonalHomeDiagnosticMessage(props.detail.message).trim() : null;
    const shownMessage = message && message !== props.shownSummary?.trim() ? message : null;
    const centered = props.align === 'center';
    const copyText = React.useCallback(() => [code, message].filter(Boolean).join('\n'), [code, message]);
    return (
        <View style={[styles.root, centered ? styles.centered : null]}>
            {shownMessage ? (
                <Text testID="personal-home-diagnostic-message" selectable style={[styles.message, centered ? styles.messageCentered : null]}>
                    {shownMessage}
                </Text>
            ) : null}
            {code ? (
                <View style={styles.codeRow}>
                    <DisclosedCodeText testID="personal-home-diagnostic-code" align={props.align}>{code}</DisclosedCodeText>
                    <CopyIconButton
                        testID="personal-home-diagnostic-copy"
                        text={copyText}
                        accessibilityLabel={t('personalHome.bootstrap.setupState.copyDetails')}
                    />
                </View>
            ) : null}
            {task ? <SystemTaskProgressCard snapshot={task} /> : null}
        </View>
    );
});
