import { describe, expect, it } from 'vitest';

import { resolveStoredImageReadScope } from './resolveStoredImageReadScope';

describe('stored Session image read scope', () => {
    const sessionScope = { serverId: 'session-home', machineId: 'session-machine', rootPath: '/workspace' };
    const daemon = { serverId: 'capture-home', machineId: 'capture-machine', happyHomeDir: 'D:\\Happier\\daemon-data' };

    it('uses the exact storage owner and never substitutes the Session workspace for unavailable daemon metadata', () => {
        expect(resolveStoredImageReadScope({ storage: 'session', sessionScope, daemon })).toBe(sessionScope);
        expect(resolveStoredImageReadScope({ storage: 'daemon', sessionScope, daemon })).toEqual({
            serverId: daemon.serverId, machineId: daemon.machineId, rootPath: daemon.happyHomeDir,
        });
        expect(resolveStoredImageReadScope({ storage: 'daemon', sessionScope,
            daemon: { ...daemon, happyHomeDir: null } })).toBeNull();
        expect(resolveStoredImageReadScope({ storage: 'daemon', sessionScope,
            daemon: { ...daemon, serverId: null } })).toBeNull();
    });
});
