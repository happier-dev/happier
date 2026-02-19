import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerSessionLogTailHandler } from './sessionLogTail';

type Handler = (data: unknown) => Promise<unknown> | unknown;

function createRpcHandlerManager(): {
    handlers: Map<string, Handler>;
    registerHandler: (method: string, handler: Handler) => void;
} {
    const handlers = new Map<string, Handler>();
    return {
        handlers,
        registerHandler(method, handler) {
            handlers.set(method, handler);
        },
    };
}

describe('registerSessionLogTailHandler', () => {
    it('returns log tail for the session log path when metadata is valid', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-log-tail-'));
        try {
            const logsDir = join(homeDir, 'logs');
            const sessionLogPath = join(logsDir, 'session.log');
            await mkdir(logsDir, { recursive: true });
            await writeFile(sessionLogPath, 'line 1\nline 2\nline 3\n', 'utf8');

            const mgr = createRpcHandlerManager();
            registerSessionLogTailHandler(mgr as unknown as RpcHandlerManager, {
                getSessionMetadata: () => ({
                    path: '/workspace',
                    host: 'host',
                    homeDir,
                    happyHomeDir: homeDir,
                    happyLibDir: '/lib',
                    happyToolsDir: '/tools',
                    sessionLogPath,
                } as any),
            });

            const handler = mgr.handlers.get(RPC_METHODS.SESSION_LOG_TAIL);
            if (!handler) throw new Error('expected session log tail handler to be registered');

            const result = await handler({ maxBytes: 128 });
            expect(result).toMatchObject({
                success: true,
            });
            expect((result as any).path).toContain('/logs/session.log');
            expect((result as any).tail).toContain('line 3');
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('rejects when sessionLogPath is outside happyHomeDir/logs', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-log-tail-'));
        try {
            const logsDir = join(homeDir, 'logs');
            const outsidePath = join(homeDir, 'outside.log');
            await mkdir(logsDir, { recursive: true });
            await writeFile(outsidePath, 'secret', 'utf8');

            const mgr = createRpcHandlerManager();
            registerSessionLogTailHandler(mgr as unknown as RpcHandlerManager, {
                getSessionMetadata: () => ({
                    path: '/workspace',
                    host: 'host',
                    homeDir,
                    happyHomeDir: homeDir,
                    happyLibDir: '/lib',
                    happyToolsDir: '/tools',
                    sessionLogPath: outsidePath,
                } as any),
            });

            const handler = mgr.handlers.get(RPC_METHODS.SESSION_LOG_TAIL);
            if (!handler) throw new Error('expected session log tail handler to be registered');

            const result = await handler({ maxBytes: 128 });
            expect(result).toMatchObject({ success: false });
            expect(String((result as any).error ?? '')).toContain('outside');
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('rejects when sessionLogPath extension is not .log', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-log-tail-'));
        try {
            const logsDir = join(homeDir, 'logs');
            const sessionLogPath = join(logsDir, 'session.txt');
            await mkdir(logsDir, { recursive: true });
            await writeFile(sessionLogPath, 'line 1\n', 'utf8');

            const mgr = createRpcHandlerManager();
            registerSessionLogTailHandler(mgr as unknown as RpcHandlerManager, {
                getSessionMetadata: () => ({
                    path: '/workspace',
                    host: 'host',
                    homeDir,
                    happyHomeDir: homeDir,
                    happyLibDir: '/lib',
                    happyToolsDir: '/tools',
                    sessionLogPath,
                } as any),
            });

            const handler = mgr.handlers.get(RPC_METHODS.SESSION_LOG_TAIL);
            if (!handler) throw new Error('expected session log tail handler to be registered');

            const result = await handler({ maxBytes: 128 });
            expect(result).toMatchObject({ success: false });
            expect(String((result as any).error ?? '')).toContain('.log');
        } finally {
            await rm(homeDir, { recursive: true, force: true });
        }
    });

    it('returns stable error when session metadata is missing log path', async () => {
        const mgr = createRpcHandlerManager();
        registerSessionLogTailHandler(mgr as unknown as RpcHandlerManager, {
            getSessionMetadata: () => ({
                path: '/workspace',
                host: 'host',
            } as any),
        });

        const handler = mgr.handlers.get(RPC_METHODS.SESSION_LOG_TAIL);
        if (!handler) throw new Error('expected session log tail handler to be registered');

        const result = await handler({});
        expect(result).toMatchObject({ success: false });
        expect(String((result as any).error ?? '')).toContain('unavailable');
    });
});
