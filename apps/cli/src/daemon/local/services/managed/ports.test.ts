import { describe, expect, it } from 'vitest';

import { createLocalServicePortAllocator } from './ports';

describe('createLocalServicePortAllocator', () => {
    it('reserves preferred ports and falls back on collision when allowed', () => {
        const allocator = createLocalServicePortAllocator({
            range: { start: 5100, end: 5102 },
            isPortAvailable: (port) => port !== 5173 && port !== 5100,
        });

        const result = allocator.reserve({
            serviceId: 'plugin-a:web',
            policy: { kind: 'allocated', preferredPort: 5173, onCollision: 'fallback' },
        });

        expect(result).toEqual({
            ok: true,
            port: 5101,
            diagnostics: [{ code: 'preferred_port_unavailable', severity: 'warning' }],
        });
    });

    it('fails fixed-port collisions when fallback is not allowed', () => {
        const allocator = createLocalServicePortAllocator({
            range: { start: 5100, end: 5102 },
            isPortAvailable: () => false,
        });

        const result = allocator.reserve({
            serviceId: 'plugin-a:web',
            policy: { kind: 'fixed', port: 5173, onCollision: 'fail' },
        });

        expect(result).toEqual({
            ok: false,
            reason: 'port_unavailable',
            diagnostics: [{ code: 'port_unavailable', severity: 'error' }],
        });
    });
});
