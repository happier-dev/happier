import { log } from '@/log';

export type PermissionActionFailureKind =
    | 'approve'
    | 'approve_all_edits'
    | 'approve_for_session'
    | 'approve_for_session_subcommand'
    | 'approve_for_session_command'
    | 'approve_execpolicy'
    | 'deny'
    | 'stop';

export type PermissionActionFailureState = Readonly<{
    action: PermissionActionFailureKind;
    sequence: number;
}>;

function readErrorRecordValue(error: unknown, key: string): unknown {
    if (!error || typeof error !== 'object') return undefined;
    return (error as Record<string, unknown>)[key];
}

function summarizePermissionActionFailure(error: unknown): string {
    const code = readErrorRecordValue(error, 'code');
    if (typeof code === 'string' && code.length > 0) {
        return `code=${code}`;
    }

    const status = readErrorRecordValue(error, 'status');
    if (typeof status === 'number' && Number.isFinite(status)) {
        return `status=${status}`;
    }

    if (error instanceof Error && error.name.length > 0) {
        return `name=${error.name}`;
    }

    return `type=${typeof error}`;
}

export function recordPermissionActionFailure(
    action: PermissionActionFailureKind,
    error: unknown,
    previousFailure: PermissionActionFailureState | null,
): PermissionActionFailureState {
    log.log(`[PermissionFooter] permission action failed: action=${action} ${summarizePermissionActionFailure(error)}`);
    return {
        action,
        sequence: (previousFailure?.sequence ?? 0) + 1,
    };
}
