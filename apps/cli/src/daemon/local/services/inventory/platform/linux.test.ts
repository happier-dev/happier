import { describe, expect, it } from 'vitest';

import { parseLinuxProcNetTcpListeners } from './linux';

describe('parseLinuxProcNetTcpListeners', () => {
    it('parses IPv4 and IPv6 listening sockets from procfs fixtures', () => {
        const listeners = parseLinuxProcNetTcpListeners({
            tcp4: [
                '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
                '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  501        0 12345 1 0000000000000000 100 0 0 10 0',
            ].join('\n'),
            tcp6: [
                '  sl  local_address                         rem_address                         st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
                '   0: 00000000000000000000000001000000:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 501        0 99999 1 0000000000000000 100 0 0 10 0',
            ].join('\n'),
            inodeToPid: new Map([
                ['12345', 321],
                ['99999', 654],
            ]),
        });

        expect(listeners).toEqual([
            { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 321 },
            { address: '::1', port: 8081, protocol: 'tcp', pid: 654 },
        ]);
    });
});
