import { describe, expect, it } from 'vitest';

import { handleRelayCliCommand } from './relay';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

describe('happier relay host help', () => {
    it('prints scoped install help for relay host install --help', async () => {
        const output = captureConsoleText();
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await handleRelayCliCommand({
                args: ['relay', 'host', 'install', '--help'],
                rawArgv: ['node', 'happier', 'relay', 'host', 'install', '--help'],
                terminalRuntime: null,
            });

            const text = output.text();
            expect(text).toContain('happier relay host install');
            expect(text).toContain('--lan');
            expect(text).toContain('--preserve-active-server');
            expect(text).not.toContain('Unknown relay host arguments');
            expect(process.exitCode).toBeUndefined();
        } finally {
            output.restore();
            process.exitCode = prevExitCode;
        }
    });
});
