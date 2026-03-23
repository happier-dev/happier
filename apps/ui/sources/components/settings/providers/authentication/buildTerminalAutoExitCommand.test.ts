import { describe, expect, it } from 'vitest';

import { buildTerminalAutoExitCommand } from './buildTerminalAutoExitCommand';

describe('buildTerminalAutoExitCommand', () => {
    it('wraps posix commands so the shell exits only after success', () => {
        expect(buildTerminalAutoExitCommand(`'/opt/tools/codex' login`, 'darwin')).toBe(
            `'/opt/tools/codex' login; __happier_auth_rc=$?; if [ \"$__happier_auth_rc\" -eq 0 ]; then exit; fi`,
        );
    });

    it('wraps windows commands with an exit-on-success guard', () => {
        expect(buildTerminalAutoExitCommand(`\"C:\\\\Tools\\\\codex.cmd\" login`, 'win32')).toBe(
            `\"C:\\\\Tools\\\\codex.cmd\" login & if not errorlevel 1 exit`,
        );
    });

    it('returns an empty command for blank input', () => {
        expect(buildTerminalAutoExitCommand('   ', 'darwin')).toBe('');
    });
});
