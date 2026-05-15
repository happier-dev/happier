import * as React from 'react';
import { View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import { SCM_OPERATION_ERROR_CODES, type ScmOperationErrorCode } from '@happier-dev/protocol';

function sanitizeDetails(details: string | null): string | null {
    if (!details) return null;
    const trimmed = details.trim();
    if (!trimmed) return null;
    if (trimmed === RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE || trimmed === RPC_ERROR_MESSAGES.METHOD_NOT_FOUND) {
        return null;
    }
    if (trimmed.includes('\n')) {
        return null;
    }
    if (/(^|\s)(fatal:|error:|remote:|hint:|usage:)/i.test(trimmed)) {
        return null;
    }
    return trimmed.length > 220 ? `${trimmed.slice(0, 220)}…` : trimmed;
}

/**
 * Map the snapshot/RPC error onto a user-facing body string.
 *
 * Branch on the structured errorCode first (single source of truth) and only fall back to the
 * raw `details` string for legacy callers that don't pass an errorCode. The previous behavior
 * matched the literal `RPC method not available` string, which mislabelled the "session has no
 * machine binding" case (sessionScm bail-out) as "daemon unreachable".
 */
function resolveBodyKey(errorCode: string | undefined, rawDetails: string): 'errors.sourceControlUnavailableForSession' | 'errors.daemonUnavailableBody' | 'errors.tryAgain' {
    if (errorCode === SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE) {
        return 'errors.sourceControlUnavailableForSession';
    }
    // Legacy: pre-errorCode callers — match the raw string only as a fallback.
    if (rawDetails === RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE) {
        return 'errors.daemonUnavailableBody';
    }
    return 'errors.tryAgain';
}

export function SourceControlUnavailableState(props: {
    details?: string | null;
    errorCode?: ScmOperationErrorCode | string | null;
    onRetry?: () => void;
}): React.ReactElement {
    const { theme } = useUnistyles();
    const trimmedDetails = typeof props.details === 'string' ? props.details.trim() : '';
    const errorCode = typeof props.errorCode === 'string' && props.errorCode.length > 0 ? props.errorCode : undefined;
    const bodyKey = resolveBodyKey(errorCode, trimmedDetails);
    const details = sanitizeDetails(props.details ?? null);

    return (
        <View
            style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                paddingTop: 40,
                paddingHorizontal: 20,
                gap: 14,
            }}
        >
            <Octicons name="alert" size={42} color={theme.colors.text.secondary} />

            <Text
                style={{
                    fontSize: 16,
                    color: theme.colors.text.secondary,
                    textAlign: 'center',
                    ...Typography.default(),
                }}
            >
                {t('common.error')}
            </Text>

            <Text
                style={{
                    fontSize: 14,
                    color: theme.colors.text.secondary,
                    textAlign: 'center',
                    ...Typography.default(),
                }}
            >
                {t(bodyKey)}
            </Text>

            {details && (
                <Text
                    style={{
                        fontSize: 12,
                        color: theme.colors.text.secondary,
                        textAlign: 'center',
                        opacity: 0.9,
                        ...Typography.default(),
                    }}
                >
                    {details}
                </Text>
            )}

            {props.onRetry && (
                <View style={{ marginTop: 6 }}>
                    <RoundButton size="normal" title={t('common.retry')} onPress={props.onRetry} />
                </View>
            )}
        </View>
    );
}
