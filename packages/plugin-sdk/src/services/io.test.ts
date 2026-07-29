import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
    PluginAgentCliReadinessService,
    PluginExecService,
    PluginJsonRpcClient,
    PluginProcessObservedTermination,
    PluginProtocolClientHandle,
    PluginSystemToolsService,
} from './io';
import * as publicIoServiceContract from './io';

describe('SVC08 public exec contract', () => {
    it('keeps the unmeasured managed-server handle capacity host-private', () => {
        expect(publicIoServiceContract).not.toHaveProperty(
            'MAX_MANAGED_SERVER_HANDLES_PER_GENERATION',
        );
    });

    it('correlates a literal protocol spec with its client type without author casts', () => {
        expectTypeOf<ReturnType<PluginExecService['clients']['spawn']>>().toMatchTypeOf<Promise<PluginProtocolClientHandle>>();

        const compileAuthor = (service: PluginExecService) => service.clients.spawn({
            kind: 'jsonRpc',
            launch: { executable: { kind: 'systemTool', id: 'fixture.tool' } },
            framing: 'jsonLines',
            maxFrameBytes: 1024,
        }).then((handle) => handle.client);
        expectTypeOf<ReturnType<typeof compileAuthor>>().toEqualTypeOf<Promise<PluginJsonRpcClient>>();
    });

    it('keeps observed process terminal causes mutually exclusive', () => {
        expectTypeOf<Extract<PluginProcessObservedTermination, { kind: 'exit' }>>()
            .toEqualTypeOf<Readonly<{ kind: 'exit'; exitCode: number }>>();
        expectTypeOf<Extract<PluginProcessObservedTermination, { kind: 'signal' }>>()
            .toEqualTypeOf<Readonly<{ kind: 'signal'; signal: string }>>();
        expectTypeOf<Extract<PluginProcessObservedTermination, { kind: 'failed' }>>()
            .not.toHaveProperty('exitCode');
    });

    it('exposes only the executable readiness fields required by native review agents', () => {
        expectTypeOf<PluginExecService['agentCli']>().toEqualTypeOf<PluginAgentCliReadinessService>();
        expectTypeOf<PluginExecService['systemTools']>().toEqualTypeOf<PluginSystemToolsService>();
        expectTypeOf<Parameters<PluginAgentCliReadinessService['checkReadiness']>[0]>()
            .toEqualTypeOf<Readonly<{
                candidates: readonly string[];
                requirement: 'any' | 'all';
                cwd?: string;
                projectId?: string;
                workspaceId?: string;
                signal?: AbortSignal;
            }>>();
        expectTypeOf<Awaited<ReturnType<PluginAgentCliReadinessService['checkReadiness']>>>()
            .toEqualTypeOf<Readonly<{
                launchable: readonly Readonly<{ agentId: string }>[];
            }>>();
        expectTypeOf<Awaited<ReturnType<PluginSystemToolsService['resolve']>>>()
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
