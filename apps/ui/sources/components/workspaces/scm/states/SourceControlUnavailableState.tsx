import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import { SCM_OPERATION_ERROR_CODES, type ScmOperationErrorCode } from '@happier-dev/protocol';
import { Icon } from '@/components/ui/icons/Icon';

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
        <SurfaceStateCard
            kind="error"
            title={t('common.error')}
            reason={t(bodyKey)}
            detail={details ?? undefined}
            icon={<Icon name="warning" size={42} color={theme.colors.text.secondary} />}
            action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : undefined}
        />
    );
}
