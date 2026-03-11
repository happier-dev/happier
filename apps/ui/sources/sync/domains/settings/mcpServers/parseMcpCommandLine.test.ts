import { describe, expect, it } from 'vitest';

import { parseMcpCommandLine } from './parseMcpCommandLine';

describe('parseMcpCommandLine', () => {
    it('splits a command line into command and args while preserving quoted segments', () => {
        expect(parseMcpCommandLine(`npx -y "@playwright/mcp@latest" --port "3000"`)).toEqual({
            command: 'npx',
            args: ['-y', '@playwright/mcp@latest', '--port', '3000'],
        });
    });

    it('returns empty args for blank input', () => {
        expect(parseMcpCommandLine('   ')).toEqual({
            command: '',
            args: [],
        });
    });
});
