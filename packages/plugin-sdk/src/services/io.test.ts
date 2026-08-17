import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
    PluginJsonRpcClient,
    PluginJsonStreamClient,
    PluginProcessHandle,
    PluginProcessObservedTermination,
    PluginProtocolClientHandle,
} from './io';
import * as publicIoServiceContract from './io';
import type {
    AgentCliReadinessService,
    ExecService,
    SystemToolsService,
} from '../exec.js';
import type { Disposable } from '../lifecycle.js';

describe('SVC08 public exec contract', () => {
    it('keeps the unmeasured managed-server handle capacity host-private', () => {
        expect(publicIoServiceContract).not.toHaveProperty(
            'MAX_MANAGED_SERVER_HANDLES_PER_GENERATION',
        );
    });

    it('correlates a literal protocol spec with its client type without author casts', () => {
        expectTypeOf<ReturnType<ExecService['clients']['spawn']>>().toMatchTypeOf<Promise<PluginProtocolClientHandle>>();

        const compileAuthor = (service: ExecService) => service.clients.spawn({
            kind: 'jsonRpc',
            launch: { executable: { kind: 'systemTool', id: 'fixture.tool' } },
            framing: 'jsonLines',
            maxFrameBytes: 1024,
        }).then((handle) => handle.client);
        expectTypeOf<ReturnType<typeof compileAuthor>>().toEqualTypeOf<Promise<PluginJsonRpcClient>>();

        const compileJsonStreamAuthor = (service: ExecService) => service.clients.spawn({
            kind: 'jsonStream',
            launch: { executable: { kind: 'systemTool', id: 'fixture.tool' } },
            maxFrameBytes: 1024,
        }).then((handle) => handle.client);
        expectTypeOf<ReturnType<typeof compileJsonStreamAuthor>>()
            .toEqualTypeOf<Promise<PluginJsonStreamClient>>();
    });

    it('keeps observed process terminal causes mutually exclusive', () => {
        expectTypeOf<Extract<PluginProcessObservedTermination, { kind: 'exit' }>>()
            .toEqualTypeOf<Readonly<{ kind: 'exit'; exitCode: number }>>();
        expectTypeOf<Extract<PluginProcessObservedTermination, { kind: 'signal' }>>()
            .toEqualTypeOf<Readonly<{ kind: 'signal'; signal: string }>>();
        expectTypeOf<Extract<PluginProcessObservedTermination, { kind: 'failed' }>>()
            .not.toHaveProperty('exitCode');
    });

    it('keeps host process identity private while preserving semantic handle operations', () => {
        expectTypeOf<PluginProcessHandle>().not.toHaveProperty('pid');
        expectTypeOf<PluginProcessHandle['write']>()
            .toEqualTypeOf<(data: Uint8Array) => Promise<void>>();
        expectTypeOf<PluginProcessHandle['closeStdin']>()
            .toEqualTypeOf<() => Promise<void>>();
        expectTypeOf<PluginProcessHandle['wait']>()
            .toEqualTypeOf<() => Promise<import('./io').PluginProcessResult>>();
        expectTypeOf<PluginProcessHandle['onOutput']>()
            .toEqualTypeOf<(listener: (chunk: import('./io').PluginProcessOutput) => void) => Disposable>();
        expectTypeOf<PluginProcessHandle['dispose']>()
            .toEqualTypeOf<() => Promise<void>>();
    });

    it('exposes only the executable readiness fields required by native review agents', () => {
        expectTypeOf<ExecService['agentCli']>().toEqualTypeOf<AgentCliReadinessService>();
        expectTypeOf<ExecService['systemTools']>().toEqualTypeOf<SystemToolsService>();
        expectTypeOf<Parameters<AgentCliReadinessService['checkReadiness']>[0]>()
            .toEqualTypeOf<Readonly<{
                candidates: readonly string[];
                requirement: 'any' | 'all';
                cwd?: string;
                projectId?: string;
                workspaceId?: string;
                signal?: AbortSignal;
            }>>();
        expectTypeOf<Awaited<ReturnType<AgentCliReadinessService['checkReadiness']>>>()
            .toEqualTypeOf<Readonly<{
                launchable: readonly Readonly<{ agentId: string }>[];
            }>>();
        expectTypeOf<Awaited<ReturnType<SystemToolsService['resolve']>>>()
            .toEqualTypeOf<Readonly<{
                executable: import('@happier-dev/protocol').ManagedExecutableRef;
                executablePath: string;
                diagnostics?: readonly Readonly<{
                    code: string;
                    detail?: Readonly<Record<string, string | number>>;
                }>[];
            }>>();
    });
});
