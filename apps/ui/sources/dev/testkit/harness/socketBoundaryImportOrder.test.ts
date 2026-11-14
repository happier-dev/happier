import { describe, expect, it, vi } from 'vitest';
import { io } from 'socket.io-client';
import { installDisconnectedServerSocketBoundary } from './serverAccountConnectionHarness';

describe('Socket transport boundary import order', () => {
    it('serves a static consumer imported before installation through the installed disconnected boundary', () => {
        // Until a suite installs the boundary the SDK stays real; loopback-server suites rely on that.
        // autoConnect:false proves the captured factory without opening a network connection.
        const before = io('https://import-order.test', { autoConnect: false });
        expect(vi.isMockFunction(before.connect)).toBe(false);
        before.disconnect();
        installDisconnectedServerSocketBoundary();
        const socket = io('https://import-order.test', { autoConnect: false });
        expect(vi.isMockFunction(socket.connect)).toBe(true);
        expect(socket.connect()).toBe(socket);
        expect(socket.connected).toBe(false);
        socket.disconnect();
    });
});
