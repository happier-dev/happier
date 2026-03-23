import type { TranslationKey } from '@/text';

export type TerminalErrorCopy = Readonly<{
    bodyKey: TranslationKey;
}>;

const COPY_BY_ERROR_CODE: Record<string, TerminalErrorCopy> = {
    terminal_missing_machine_target: { bodyKey: 'terminalEmbedded.errors.missingMachineTarget' },
    terminal_rpc_target_unavailable: { bodyKey: 'terminalEmbedded.errors.rpcTargetUnavailable' },
    terminal_machine_unreachable: { bodyKey: 'terminalEmbedded.errors.machineUnreachable' },
    terminal_disabled: { bodyKey: 'terminalEmbedded.errors.disabled' },
    terminal_not_found: { bodyKey: 'terminalEmbedded.errors.notFound' },
    terminal_cwd_denied: { bodyKey: 'terminalEmbedded.errors.cwdDenied' },
    terminal_spawn_failed: { bodyKey: 'terminalEmbedded.errors.spawnFailed' },
    terminal_invalid_request: { bodyKey: 'terminalEmbedded.errors.invalidRequest' },
    terminal_busy: { bodyKey: 'terminalEmbedded.errors.busy' },
};

export function resolveTerminalErrorCopy(errorCode: string | null): TerminalErrorCopy | null {
    const code = typeof errorCode === 'string' ? errorCode.trim() : '';
    if (!code) return null;
    return COPY_BY_ERROR_CODE[code] ?? null;
}
