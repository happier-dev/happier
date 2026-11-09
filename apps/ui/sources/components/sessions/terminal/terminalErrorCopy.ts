import type { TranslationKey } from '@/text';

export type TerminalErrorCopy = Readonly<{
    bodyKey: TranslationKey;
}>;

const COPY_BY_ERROR_CODE: Record<string, TerminalErrorCopy> = {
    terminal_forbidden: { bodyKey: 'machines.terminals.denied' },
    terminal_access_denied: { bodyKey: 'machines.terminals.denied' },
    access_denied: { bodyKey: 'machines.terminals.denied' },
    terminal_unavailable: { bodyKey: 'machines.terminals.unavailable' },
    outcome_unknown: { bodyKey: 'machines.terminals.openUnknown' },
    terminal_missing_machine_target: { bodyKey: 'terminalEmbedded.errors.missingMachineTarget' },
    terminal_rpc_target_unavailable: { bodyKey: 'terminalEmbedded.errors.rpcTargetUnavailable' },
    terminal_machine_unreachable: { bodyKey: 'terminalEmbedded.errors.machineUnreachable' },
    terminal_disabled: { bodyKey: 'terminalEmbedded.errors.disabled' },
    terminal_not_found: { bodyKey: 'terminalEmbedded.errors.notFound' },
    terminal_cwd_denied: { bodyKey: 'terminalEmbedded.errors.cwdDenied' },
    terminal_spawn_failed: { bodyKey: 'terminalEmbedded.errors.spawnFailed' },
    terminal_invalid_request: { bodyKey: 'terminalEmbedded.errors.invalidRequest' },
    cli_update_required: { bodyKey: 'deps.ui.notAvailableUpdateCli' },
    project_requester_credentials_unavailable: { bodyKey: 'terminalEmbedded.errors.projectRequesterCredentialsUnavailable' },
    project_workspace_changed: { bodyKey: 'terminalEmbedded.errors.projectWorkspaceChanged' },
    project_workspace_unavailable: { bodyKey: 'terminalEmbedded.errors.projectWorkspaceUnavailable' },
    project_setup_consent_required: { bodyKey: 'terminalEmbedded.errors.projectSetupConsentRequired' },
    project_setup_effect_changed: { bodyKey: 'terminalEmbedded.errors.projectSetupEffectChanged' },
    terminal_busy: { bodyKey: 'terminalEmbedded.errors.busy' },
};

export function resolveTerminalAdmissionErrorCode(
    failure: Readonly<{ errorCode: string; error: string }>,
): string {
    const detail = failure.error.trim();
    return failure.errorCode === 'terminal_invalid_request' && COPY_BY_ERROR_CODE[detail]
        ? detail
        : failure.errorCode;
}

export function resolveTerminalErrorCopy(errorCode: string | null): TerminalErrorCopy | null {
    const code = typeof errorCode === 'string' ? errorCode.trim() : '';
    if (!code) return null;
    return COPY_BY_ERROR_CODE[code] ?? null;
}
