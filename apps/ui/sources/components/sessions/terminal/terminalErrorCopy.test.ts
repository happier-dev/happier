import { describe, expect, it } from 'vitest';

import { resolveTerminalAdmissionErrorCode, resolveTerminalErrorCopy } from './terminalErrorCopy';

describe('terminal error copy', () => {
    it('presents an operation-scoped daemon update result through the terminal envelope', () => {
        const code = resolveTerminalAdmissionErrorCode({
            errorCode: 'terminal_invalid_request', error: 'cli_update_required',
        });
        expect(code).toBe('cli_update_required');
        expect(resolveTerminalErrorCopy(code)).toEqual({ bodyKey: 'deps.ui.notAvailableUpdateCli' });
    });

    it('carries a recognized Project preparation refusal through the generic terminal envelope', () => {
        const code = resolveTerminalAdmissionErrorCode({
            errorCode: 'terminal_invalid_request',
            error: 'project_requester_credentials_unavailable',
        });

        expect(code).toBe('project_requester_credentials_unavailable');
        expect(resolveTerminalErrorCopy(code)).toEqual({
            bodyKey: 'terminalEmbedded.errors.projectRequesterCredentialsUnavailable',
        });
    });

    it('keeps the admitted envelope code when its detail is not a known user-facing cause', () => {
        expect(resolveTerminalAdmissionErrorCode({
            errorCode: 'terminal_invalid_request',
            error: 'private daemon detail',
        })).toBe('terminal_invalid_request');
    });
});
