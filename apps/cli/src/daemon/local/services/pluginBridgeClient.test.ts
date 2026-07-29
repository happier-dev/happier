import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalServiceDeclarationV1 } from '@/plugins/runtime/exec/privateContract';
import {
    HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_ENV_KEY,
    HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE_ENV_KEY,
} from './pluginBridgeProtocol';

const dispatchDaemonPluginLocalServicesBridgeRequestMock = vi.hoisted(() => vi.fn());

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/daemon/controlClient')>()),
    dispatchDaemonPluginLocalServicesBridgeRequest: dispatchDaemonPluginLocalServicesBridgeRequestMock,
}));

import { createDaemonControlPluginLocalServicesRuntime } from './pluginBridgeClient';

describe('daemon-control plugin local-services bridge client', () => {
    const originalBridgeToken = process.env[HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_ENV_KEY];
    const originalBridgeTokenFile = process.env[HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE_ENV_KEY];
    let tempDir: string | null = null;

    beforeEach(() => {
        dispatchDaemonPluginLocalServicesBridgeRequestMock.mockReset();
        process.env[HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_ENV_KEY] = 'bridge-token-session-1';
        delete process.env[HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE_ENV_KEY];
    });

    afterEach(() => {
        if (typeof originalBridgeToken === 'undefined') {
            delete process.env[HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_ENV_KEY];
        } else {
            process.env[HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_ENV_KEY] = originalBridgeToken;
        }
        if (typeof originalBridgeTokenFile === 'undefined') {
            delete process.env[HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE_ENV_KEY];
        } else {
            process.env[HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE_ENV_KEY] = originalBridgeTokenFile;
        }
        if (tempDir) {
            rmSync(tempDir, { recursive: true, force: true });
            tempDir = null;
        }
    });

    it('dispatches plugin local-service start through the daemon control bridge', async () => {
        const snapshot = {
            id: 'web',
            phase: 'running' as const,
            port: 5173,
            url: 'https://preview.happier.test/plugin-web/',
            diagnostics: [],
        };
        dispatchDaemonPluginLocalServicesBridgeRequestMock.mockResolvedValue({ ok: true, snapshot });
        const runtime = createDaemonControlPluginLocalServicesRuntime();
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.plugin',
            contributionId: 'acme.plugin.backend',
            sessionId: 'session-1',
            title: 'Preview Session',
        });
        const declaration: LocalServiceDeclarationV1 = {
            id: 'web',
            launch: {
                kind: 'binary',
                executablePath: '/bin/sh',
                args: Object.freeze(['-lc', 'npm run dev']),
                env: Object.freeze({ NODE_ENV: 'development' }),
            },
            launchMode: {
                kind: 'assignAndInject',
                portPolicy: { kind: 'allocated', preferredPort: 5173 },
                environment: { inject: Object.freeze(['PORT', 'HOST']) },
            },
            hostPolicy: { kind: 'loopback' },
            name: { strategy: 'derived', base: 'web' },
            healthCheck: { kind: 'none' },
            restart: { kind: 'never' },
            cleanup: { staleAfterMs: 30_000 },
        };

        await expect(bridge.start(declaration)).resolves.toEqual(snapshot);

        expect(dispatchDaemonPluginLocalServicesBridgeRequestMock).toHaveBeenCalledWith({
            protocolVersion: 1,
            bridgeToken: 'bridge-token-session-1',
            context: {
                pluginId: 'acme.plugin',
                contributionId: 'acme.plugin.backend',
                sessionId: 'session-1',
                title: 'Preview Session',
            },
            operation: {
                kind: 'start',
                declaration: {
                    ...declaration,
                    launch: {
                        kind: 'binary',
                        executablePath: '/bin/sh',
                        args: ['-lc', 'npm run dev'],
                        env: { NODE_ENV: 'development' },
                    },
                    launchMode: {
                        kind: 'assignAndInject',
                        portPolicy: { kind: 'allocated', preferredPort: 5173 },
                        environment: { inject: ['PORT', 'HOST'] },
                    },
                },
            },
        });
    });

    it('rejects binary stdin before sending a JSON control request', async () => {
        const runtime = createDaemonControlPluginLocalServicesRuntime();
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.plugin',
            contributionId: 'acme.plugin.backend',
            sessionId: 'session-1',
            title: 'Preview Session',
        });
        const declaration: LocalServiceDeclarationV1 = {
            id: 'web',
            launch: {
                kind: 'binary',
                executablePath: '/bin/sh',
                stdin: new Uint8Array([1, 2, 3]),
            },
            launchMode: { kind: 'detectAfterLaunch' },
            hostPolicy: { kind: 'loopback' },
            name: { strategy: 'derived', base: 'web' },
            healthCheck: { kind: 'none' },
            restart: { kind: 'never' },
            cleanup: { staleAfterMs: 30_000 },
        };

        await expect(bridge.start(declaration)).rejects.toThrow(/binary stdin/u);
        expect(dispatchDaemonPluginLocalServicesBridgeRequestMock).not.toHaveBeenCalled();
    });

    it('rejects managed-installable launches before sending a JSON control request', async () => {
        const runtime = createDaemonControlPluginLocalServicesRuntime();
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.plugin',
            contributionId: 'acme.plugin.backend',
            sessionId: 'session-1',
            title: 'Preview Session',
        });
        const declaration: LocalServiceDeclarationV1 = {
            id: 'web',
            launch: {
                kind: 'managed-installable',
                installableId: 'node',
            },
            launchMode: { kind: 'detectAfterLaunch' },
            hostPolicy: { kind: 'loopback' },
            name: { strategy: 'derived', base: 'web' },
            healthCheck: { kind: 'none' },
            restart: { kind: 'never' },
            cleanup: { staleAfterMs: 30_000 },
        };

        await expect(bridge.start(declaration)).rejects.toThrow(/managed-installable/u);
        expect(dispatchDaemonPluginLocalServicesBridgeRequestMock).not.toHaveBeenCalled();
    });

    it('requires the daemon-issued bridge token before creating a bridge', () => {
        delete process.env[HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_ENV_KEY];
        const runtime = createDaemonControlPluginLocalServicesRuntime();

        expect(() => runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.plugin',
            contributionId: 'acme.plugin.backend',
            sessionId: 'session-1',
            title: 'Preview Session',
        })).toThrow(/bridge token/u);
        expect(dispatchDaemonPluginLocalServicesBridgeRequestMock).not.toHaveBeenCalled();
    });

    it('reads the daemon-issued bridge token from the token file environment when direct token env is absent', async () => {
        tempDir = mkdtempSync(join(tmpdir(), 'happier-plugin-bridge-client-'));
        const tokenFilePath = join(tempDir, 'bridge-token');
        writeFileSync(tokenFilePath, 'bridge-token-from-file\n', { encoding: 'utf8', mode: 0o600 });
        delete process.env[HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_ENV_KEY];
        process.env[HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE_ENV_KEY] = tokenFilePath;
        dispatchDaemonPluginLocalServicesBridgeRequestMock.mockResolvedValue({ ok: true, snapshot: null });

        const runtime = createDaemonControlPluginLocalServicesRuntime();
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.plugin',
            contributionId: 'acme.plugin.backend',
            sessionId: 'session-1',
            title: 'Preview Session',
        });

        if (!bridge.get) {
            throw new Error('expected bridge.get to be available');
        }
        await expect(bridge.get('web')).resolves.toBeNull();
        expect(dispatchDaemonPluginLocalServicesBridgeRequestMock).toHaveBeenCalledWith(expect.objectContaining({
            bridgeToken: 'bridge-token-from-file',
        }));
    });
});
