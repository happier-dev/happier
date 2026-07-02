import { describe, expect, it, vi } from 'vitest';

import { parseDarwinLsofTcpListenOutput, readDarwinLocalServiceListeners } from './darwin';

describe('parseDarwinLsofTcpListenOutput', () => {
    it('parses lsof field output into listener facts', () => {
        expect(parseDarwinLsofTcpListenOutput([
            'p123',
            'cnode',
            'nTCP 127.0.0.1:5173 (LISTEN)',
            'p456',
            'cnode',
            'nTCP *:8080 (LISTEN)',
        ].join('\n'))).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 123 },
            { address: '0.0.0.0', port: 8080, protocol: 'tcp', pid: 456 },
        ]);
    });

    it('reads listeners through the lsof system boundary', async () => {
        const execFile = vi.fn(async () => ({
            stdout: [
                'p123',
                'nTCP 127.0.0.1:5173 (LISTEN)',
            ].join('\n'),
        }));

        await expect(readDarwinLocalServiceListeners({ execFile })).resolves.toEqual({
            listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 123 }],
            diagnostics: [],
        });
        expect(execFile).toHaveBeenCalledWith('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], {
            timeout: 2_000,
            maxBuffer: 1024 * 1024,
        });
    });
});
