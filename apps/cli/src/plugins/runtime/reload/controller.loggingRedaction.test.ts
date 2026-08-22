import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { Logger, logger } from '../../../ui/logger';
import { createPluginReloadController } from './controller';

const loggerConfiguration = vi.hoisted(() => ({
    happyHomeDir: '',
    logsDir: '',
}));

vi.mock('../../../configuration', () => ({
    configuration: {
        isDaemonProcess: false,
        get happyHomeDir() {
            return loggerConfiguration.happyHomeDir;
        },
        get logsDir() {
            return loggerConfiguration.logsDir;
        },
    },
}));

function createRuntimeRegistry(): ResolvedExecutablePluginRuntimeRegistry {
    return {
        contributes: {
            agents: Object.freeze([]),
            providers: Object.freeze([]),
            actions: Object.freeze([]),
            resources: Object.freeze([]),
            uiViewsV2: Object.freeze([]),
            uiRenderersV2: Object.freeze([]),
            uiTranslationsV2: Object.freeze([]),
            activationTargets: Object.freeze([]),
            catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
        },
        hookHandlersByHookId: new Map(),
        agentRuntimesByAgentId: new Map(),
        scmHostingProvidersById: new Map(),
        pluginDiagnosticsByPluginId: Object.freeze({}),
        activatedPluginIds: new Set(),
        activateContributionsOnDemand: async () => [],
        resolvePromptAssetBlocks: async () => [],
        retireConsumers: () => undefined,
        retirePluginConsumers: () => undefined,
        addRuntimeDisposable: (_pluginId, disposable) => disposable,
        createAgentInvocationServices: async () => {
            throw new Error('Reload-listener logging fixture does not invoke Agent services');
        },
        dispose: async () => undefined,
    };
}

function createListenerError(): Error {
    const error = new Error('client_secret=leak');
    error.stack = 'BEGIN_STACK client_secret=stack-leak END_STACK';
    return error;
}

function readLoggedError(message: string): string {
    const listenerThrewIndex = message.indexOf('listener threw');
    expect(listenerThrewIndex).toBeGreaterThanOrEqual(0);
    const rendered = message.slice(listenerThrewIndex + 'listener threw'.length).trim();
    if (!rendered.startsWith('{')) return rendered;

    const payload: unknown = JSON.parse(rendered);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Expected reload listener log payload object');
    }
    expect(Object.keys(payload)).toEqual(['error']);
    if (!('error' in payload) || typeof payload.error !== 'string') {
        throw new Error('Expected reload listener log payload error');
    }
    return payload.error;
}

function readRemoteProjectedError(body: unknown): string {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('Expected remote reload listener payload object');
    }
    if (!('level' in body) || !('message' in body)) {
        throw new Error('Expected remote reload listener payload fields');
    }
    expect(body.level).toBe('debug');
    if (typeof body.message !== 'string') throw new Error('Expected remote reload listener message');
    return readLoggedError(body.message);
}

describe('plugin reload listener diagnostic logging', () => {
    const envKeys = [
        'DEBUG',
        'HAPPIER_HOME_DIR',
        'HAPPIER_LOG_LEVEL',
        'DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING',
        'HAPPIER_SERVER_URL',
    ] as const;
    let tempDir: string;
    let previousEnvironment: Record<string, string | undefined>;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'happier-reload-listener-redaction-'));
        previousEnvironment = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
        delete process.env.DEBUG;
        process.env.HAPPIER_HOME_DIR = tempDir;
        process.env.HAPPIER_LOG_LEVEL = 'debug';
        process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = '1';
        process.env.HAPPIER_SERVER_URL = 'https://logs.example.test';
        loggerConfiguration.happyHomeDir = tempDir;
        loggerConfiguration.logsDir = join(tempDir, 'logs');
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        rmSync(tempDir, { recursive: true, force: true });
        loggerConfiguration.happyHomeDir = '';
        loggerConfiguration.logsDir = '';
        for (const key of envKeys) {
            const previous = previousEnvironment[key];
            if (previous === undefined) delete process.env[key];
            else process.env[key] = previous;
        }
    });

    it('projects thrown reload-listener failures before file and remote debug logging', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const isolatedLogger = new Logger(join(tempDir, 'reload-listener.log'));
        vi.spyOn(isolatedLogger, 'localTimezoneTimestamp').mockReturnValue('00:00:00.000');
        vi.spyOn(logger, 'debug').mockImplementation((message, ...args) => {
            isolatedLogger.debug(message, ...args);
        });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => createRuntimeRegistry(),
        });
        controller.subscribe(() => {
            throw createListenerError();
        });
        controller.subscribeRunningSessionDisposition(() => {
            throw createListenerError();
        });

        const lease = await controller.acquireRuntimeRegistry();
        await lease.release();
        controller.publishDurableRunningSessionDisposition({
            durableRevision: 1,
            changedPluginIds: [],
            runningSessionDisposition: 'retainRunningSessions',
        });
        isolatedLogger.flushSync();

        expect(existsSync(isolatedLogger.getLogPath())).toBe(true);
        const fileLines = readFileSync(isolatedLogger.getLogPath(), 'utf8')
            .split('\n')
            .filter((line) => line.includes('listener threw'));
        expect(fileLines).toHaveLength(2);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

        const remoteBodies = fetchMock.mock.calls.map(([, init]) => {
            const body = init?.body;
            if (typeof body !== 'string') throw new Error('Expected remote logger request body to be a string');
            return JSON.parse(body);
        });
        const projectedErrors = [
            ...fileLines.map(readLoggedError),
            ...remoteBodies.map(readRemoteProjectedError),
        ];
        for (const projected of projectedErrors) {
            expect(projected).toBe('client_secret: [REDACTED]');
            expect(projected).not.toContain('leak');
            expect(projected).not.toContain('stack-leak');
            expect(projected).not.toContain('BEGIN_STACK');
            expect(Buffer.byteLength(projected, 'utf8')).toBeLessThanOrEqual(2_048);
        }

        await controller.shutdown();
    });

    it('keeps trust-rejected cold plugins visible while publishing the healthy registry', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const registry = Object.freeze({
            ...createRuntimeRegistry(),
            pluginDiagnosticsByPluginId: Object.freeze({
                'acme.trust-rejected': Object.freeze([
                    Object.freeze({
                        code: 'plugin_trust_approval_required' as const,
                        message: 'Approval required',
                    }),
                ]),
            }),
        });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registry,
        });

        const lease = await controller.acquireRuntimeRegistry();
        expect(lease.registry).toBe(registry);
        expect(controller.getState()).toMatchObject({
            activeRegistry: registry,
            lastResult: {
                ok: true,
                registryStatus: 'active',
                diagnosticsByPluginId: registry.pluginDiagnosticsByPluginId,
            },
        });
        expect(warn).toHaveBeenCalledWith(
            '[PLUGIN RUNTIME] Cold startup isolated unavailable plugin activations',
            { pluginIds: ['acme.trust-rejected'] },
        );

        await lease.release();
        await controller.shutdown();
    });
});
