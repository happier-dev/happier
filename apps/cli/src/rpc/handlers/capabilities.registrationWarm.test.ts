import { afterEach, describe, expect, it } from 'vitest';
import { Session } from 'node:inspector';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { RpcHandler } from '@/api/rpc/types';
import { createFilesystemEffectAdmission } from './fileSystem/accessPolicy/filesystemEffectAdmission';
import { registerCapabilitiesHandlers } from './capabilities';

type Coverage = { result: Array<{ functions: Array<{ functionName: string; ranges: Array<{ count: number }> }> }> };

const environment = createEnvKeyScope(['HAPPIER_HOME_DIR']);
const roots: string[] = [];

afterEach(async () => {
    environment.restore();
    reloadConfiguration();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Precise coverage resets its counters on every take, so a take before and after a run counts that run.
// Only synchronous functions are counted: an async function's resumptions would inflate its count.
async function countCalls(names: readonly string[], run: () => Promise<void>): Promise<Record<string, number>> {
    const inspector = new Session();
    const post = <R>(method: string, params?: Record<string, unknown>) => new Promise<R>((resolve, reject) => {
        inspector.post(method, params ?? {}, (error, result) => error ? reject(error) : resolve(result as R));
    });
    inspector.connect();
    try {
        await post('Profiler.enable');
        await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
        await post('Profiler.takePreciseCoverage');
        await run();
        const coverage = await post<Coverage>('Profiler.takePreciseCoverage');
        const functions = coverage.result.flatMap(script => script.functions);
        return Object.fromEntries(names.map(name => [name, functions
            .filter(fn => fn.functionName === name)
            .reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0)]));
    } finally {
        await new Promise<void>(resolve => inspector.post('Profiler.stopPreciseCoverage', () => resolve()));
        inspector.disconnect();
    }
}

async function register(options: Readonly<{ warmOnRegister?: boolean }>) {
    const root = await mkdtemp(join(tmpdir(), 'happier-capabilities-warm-'));
    roots.push(root);
    environment.patch({ HAPPIER_HOME_DIR: root });
    reloadConfiguration();
    const handlers = new Map<string, RpcHandler>();
    registerCapabilitiesHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
        ...options,
        hasSessionAgentTransition: () => true,
        readPluginCatalog: async () => [],
        filesystemEffectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => null }),
    });
    return handlers;
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 50));

describe('capabilities service creation at handler registration', () => {
    const detect = (handlers: Map<string, RpcHandler>) =>
        handlers.get(RPC_METHODS.CAPABILITIES_DETECT)!({ requests: [{ id: 'tool.sessionAgentTransition' }] });

    it('builds nothing at registration unless the registrar asks for a warm service, then once on first demand', async () => {
        let handlers = new Map<string, RpcHandler>();
        const atRegistration = await countCalls(['getService', 'createCapabilitiesService'], async () => {
            handlers = await register({});
            await settle();
        });
        expect(atRegistration).toEqual({ getService: 0, createCapabilitiesService: 0 });
        const onDemand = await countCalls(['createCapabilitiesService'], async () => {
            await detect(handlers);
            await detect(handlers);
        });
        expect(onDemand).toEqual({ createCapabilitiesService: 1 });
    });

    it('starts building the service at registration for a registrar that warms it', async () => {
        const atRegistration = await countCalls(['getService'], async () => {
            await register({ warmOnRegister: true });
        });
        expect(atRegistration).toEqual({ getService: 1 });
    });
});
