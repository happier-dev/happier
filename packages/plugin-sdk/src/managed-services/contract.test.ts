import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { Disposable, PluginCancellationOptions } from '../lifecycle.js';

import {
    ManagedServiceLocalIdSchema as ProtocolManagedServiceLocalIdSchema,
    readManagedServiceEndpointUrl as protocolReadManagedServiceEndpointUrl,
    type PluginContributionLocalId,
    type ManagedServiceEndpointHostPolicy as ProtocolManagedServiceEndpointHostPolicy,
    type ManagedServiceEndpointUrlFacts as ProtocolManagedServiceEndpointUrlFacts,
    type ManagedServiceEndpointUrlRejection as ProtocolManagedServiceEndpointUrlRejection,
    type ManagedServiceEndpointUrlResult as ProtocolManagedServiceEndpointUrlResult,
} from '@happier-dev/protocol';

import {
    ManagedServiceLocalIdSchema,
    readManagedServiceEndpointUrl,
    type ManagedServiceLocalId,
    type ManagedServiceEndpointHostPolicy,
    type ManagedServiceEndpointUrlFacts,
    type ManagedServiceEndpointUrlRejection,
    type ManagedServiceEndpointUrlResult,
    type ManagedServiceNativeLogReadV1,
    type ManagedServiceNativeLogWatchV1,
    type ManagedServiceNativeLogResultV1,
    type ManagedServiceNativeInstanceV1,
    type ManagedServiceNativeLifecycleV1,
} from './index.js';
import type {
    ManagedServiceAttachClientAccess,
    ManagedServiceCredentialBinding,
    ManagedServiceErrorCode,
    ManagedServiceHandle,
    ManagedServiceRequest,
    ManagedServiceResponse,
    ManagedServiceHealthCheck,
    ManagedServiceSnapshot,
    ManagedServiceSpec,
    ManagedServices,
} from './index.js';
import type { ExecSpawnRequest } from '../exec/index.js';
import type {
    ManagedProviderEndpoint,
    ManagedProviderRuntime,
    ManagedProviderRuntimeContext,
    ManagedProviderStartRequest,
    ProviderLocalId,
    ProvidersRegistrationApi,
} from '../providers/index.js';

type SpawnManagedServiceSpec = Extract<
    ManagedServiceSpec,
    Readonly<{ mode: Readonly<{ kind: 'spawn' }> }>
>;
type AttachManagedServiceSpec = Extract<
    ManagedServiceSpec,
    Readonly<{ mode: Readonly<{ kind: 'attach' }> }>
>;

if (false) {
    /* @sdk-negative-type-case:src-managed-services-contract-test-ts-209:LS0gcmVxdWVzdC1hdXRoIGNhcGFiaWxpdHkgaW5qZWN0aW9uIHJlcXVpcmVzIGFuIG93bmVkIHNwYXduZWQgY2hpbGQu:Y29uc3QgYXR0YWNoUmVxdWVzdEF1dGg6IEF0dGFjaE1hbmFnZWRTZXJ2aWNlU3BlYyA9IHsKICAgICAgICBpZDogJ2F0dGFjaGVkLXNlcnZpY2UnLAogICAgICAgIG1vZGU6IHsga2luZDogJ2F0dGFjaCcsIGJhc2VVcmw6ICdodHRwOi8vMTI3LjAuMC4xOjQzMTInIH0sCgpyZXF1ZXN0QXV0aDogewogICAgICAgICAgICBraW5kOiAnY29ubmVjdGVkQWNjb3VudENhcGFiaWxpdHlQYXRoJywKICAgICAgICAgICAgaW5qZWN0RW52aXJvbm1lbnRLZXk6ICdSRVFVRVNUX0FVVEhfQ0FQQUJJTElUWScsCiAgICAgICAgfSwKICAgIH07 */
const attachRequestAuth = undefined as never; /* @sdk-negative-type-case-end */
    void attachRequestAuth;
}

describe('managed-services author contract', () => {
    it('authors both required log overloads in the public example without reading for unsupported follow', async () => {
        // Keep the copyable author's public declarations out of the SDK's source TS program.
        const example = await import(new URL('../../examples/public-authoring/daemon.ts', import.meta.url).href) as Partial<{
            createBoundedNativeServiceLogs(read: (instance: ManagedServiceNativeInstanceV1, signal?: AbortSignal) =>
                Promise<Readonly<{ sourceRevision: string; redactedText: string }>>): NonNullable<ManagedServiceNativeLifecycleV1['logs']>;
        }>;
        expect(example.createBoundedNativeServiceLogs).toBeTypeOf('function');
        if (!example.createBoundedNativeServiceLogs) throw new Error('public_native_logs_example_unavailable');
        const instance = { adapter: { pluginId: 'acme.native-service', localId: 'service' }, nativeResourceId: 'service-1' };
        let reads = 0;
        // Native log IO is the external boundary; the maintained author implementation is real.
        const logs = example.createBoundedNativeServiceLogs(async () => {
            reads++;
            return { sourceRevision: 'native-source', redactedText: 'ééé' };
        });
        const events: ManagedServiceNativeLogResultV1[] = [];
        const follow = await logs(instance, { kind: 'watch', maxBytes: 5, emit: result => events.push(result) });
        expect(events).toEqual([{ kind: 'unavailable', reason: 'unsupported' }]);
        expect(reads).toBe(0);
        await follow.dispose();
        expect(await logs(instance, { kind: 'read', maxBytes: 5 })).toEqual({ kind: 'page', page: {
            sourceRevision: 'native-source', text: 'éé', nextCursor: null, truncated: true,
        } });
        const cancelled = new AbortController();
        cancelled.abort();
        await expect(logs(instance, { kind: 'read', maxBytes: 5, signal: cancelled.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(reads).toBe(1);
    });

    it('retains optional native adapter discovery, controls and accounting through public registration', async () => {
        const instance = { adapter: { pluginId: 'acme.native-service', localId: 'service' }, nativeResourceId: 'service-1' };
        const machine = { serverId: 'server-1', machineId: 'machine-1' };
        const controller = new AbortController();
        const reads: string[] = [];
        let followDisposed = 0;
        function logs(candidate: typeof instance, request: ManagedServiceNativeLogReadV1): Promise<ManagedServiceNativeLogResultV1>;
        function logs(candidate: typeof instance, request: ManagedServiceNativeLogWatchV1): Promise<import('../lifecycle.js').Disposable>;
        async function logs(candidate: typeof instance, request: ManagedServiceNativeLogReadV1 | ManagedServiceNativeLogWatchV1): Promise<ManagedServiceNativeLogResultV1 | Disposable> {
            expect(candidate).toBe(instance);
            expect(request.signal).toBe(controller.signal);
            reads.push(request.kind);
            const result: ManagedServiceNativeLogResultV1 = { kind: 'page', page: { sourceRevision: 'source-one',
                text: 'native output', nextCursor: { sourceRevision: 'source-one', token: 'next' }, truncated: false } };
            if (request.kind === 'read') return result;
            expect(request.cursor).toEqual(result.page.nextCursor);
            request.emit(result);
            return { dispose() { followDisposed++; } };
        }
        let phase: 'running' | 'stopped' = 'stopped';
        const observation = () => ({ phase, readiness: 'not_reported' as const, endpoint: null });
        const runtime = {
            logs,
            async inspect() { return observation(); },
            async stop() { phase = 'stopped'; return { status: 'stopped' as const }; },
            async discover(request: typeof machine, options?: PluginCancellationOptions) {
                reads.push('discovery');
                expect(request).toBe(machine);
                expect(options?.signal).toBe(controller.signal);
                return { kind: 'partial' as const, candidates: [{ instance, name: 'Native service', observation: observation() }],
                    failures: [{ kind: 'unavailable' as const, code: 'native_permission_required' }] };
            },
            async start(candidate: typeof instance) {
                expect(candidate).toBe(instance);
                phase = 'running';
                return observation();
            },
            async restart(candidate: typeof instance) {
                expect(candidate).toBe(instance);
                return { kind: 'unavailable' as const, code: 'native_restart_unavailable' };
            },
            async accounting(instances: readonly (typeof instance)[], options?: PluginCancellationOptions) {
                reads.push('accounting');
                expect(instances).toEqual([instance]);
                expect(options?.signal).toBe(controller.signal);
                return { kind: 'sample' as const, samples: [{ instance, cpuPercent: null, memoryBytes: 512 }] };
            },
        };
        const testkit = await createPluginTestkit({
            manifest: { schemaVersion: 2, id: instance.adapter.pluginId, version: '1.0.0', displayName: 'Native service',
                runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.js' },
                contributes: { projectNativeAdapters: [{ id: instance.adapter.localId, files: ['service.json'], roles: ['nativeServiceLifecycle'] }] } },
            module: { activate(api) { api.projectNativeAdapters.register(instance.adapter.localId, { nativeServiceLifecycle: runtime }); } },
        });
        try {
            // Declaring/capturing a capability must not discover or sample native resources.
            expect(reads).toEqual([]);
            const lifecycle = testkit.registration('projectNativeAdapters', instance.adapter.localId)?.nativeServiceLifecycle;
            expect(lifecycle).toMatchObject({ discover: expect.any(Function), start: expect.any(Function), restart: expect.any(Function), accounting: expect.any(Function) });
            expect(await lifecycle?.discover?.(machine, { signal: controller.signal })).toMatchObject({ kind: 'partial', candidates: [{ instance }], failures: [{ code: 'native_permission_required' }] });
            expect(await lifecycle?.start?.(instance)).toEqual({ phase: 'running', readiness: 'not_reported', endpoint: null });
            expect(await lifecycle?.inspect(instance)).toEqual({ phase: 'running', readiness: 'not_reported', endpoint: null });
            expect(await lifecycle?.restart?.(instance)).toEqual({ kind: 'unavailable', code: 'native_restart_unavailable' });
            expect(await lifecycle?.accounting?.([instance], { signal: controller.signal })).toEqual({ kind: 'sample', samples: [{ instance, cpuPercent: null, memoryBytes: 512 }] });
            expect(reads).toEqual(['discovery', 'accounting']);
            const page = await lifecycle?.logs?.(instance, { kind: 'read', maxBytes: 8_192, signal: controller.signal });
            if (page?.kind !== 'page' || !page.page.nextCursor) throw new Error('Expected bounded cursor page');
            const followed: ManagedServiceNativeLogResultV1[] = [];
            const follow = await lifecycle?.logs?.(instance, { kind: 'watch', maxBytes: 8_192, cursor: page.page.nextCursor,
                signal: controller.signal, emit: value => followed.push(value) });
            expect(followed).toEqual([page]);
            await follow?.dispose();
            expect(followDisposed).toBe(1);
            expect(reads).toEqual(['discovery', 'accounting', 'read', 'watch']);
            expect(await lifecycle?.stop(instance)).toEqual({ status: 'stopped' });
            expect(await lifecycle?.inspect(instance)).toEqual({ phase: 'stopped', readiness: 'not_reported', endpoint: null });
        } finally { await testkit.dispose(); }
    });

    it('keeps omitted native service capabilities absent after public registration', async () => {
        const testkit = await createPluginTestkit({
            manifest: { schemaVersion: 2, id: 'acme.inspect-service', version: '1.0.0', displayName: 'Inspect service',
                runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.js' },
                contributes: { projectNativeAdapters: [{ id: 'service', files: ['service.json'], roles: ['nativeServiceLifecycle'] }] } },
            module: { activate(api) { api.projectNativeAdapters.register('service', { nativeServiceLifecycle: {
                async inspect() { return { phase: 'unknown', readiness: 'not_reported', endpoint: null }; },
                async stop() { return { kind: 'unsupported', code: 'fixture_stop_unsupported' }; },
            } }); } },
        });
        try {
            const lifecycle = testkit.registration('projectNativeAdapters', 'service')?.nativeServiceLifecycle;
            expect(lifecycle).toBeDefined();
            for (const method of ['discover', 'start', 'restart', 'accounting', 'logs'] as const) {
                expect(lifecycle?.[method]).toBeUndefined();
            }
        } finally { await testkit.dispose(); }
    });

    it('projects credential bindings through the public Connected Accounts declaration owner', async () => {
        const sourcePath = fileURLToPath(new URL('./contract.ts', import.meta.url));
        const source = await readFile(sourcePath, 'utf8');
        const declaration = ts.transpileDeclaration(source, {
            fileName: sourcePath,
            compilerOptions: {
                module: ts.ModuleKind.NodeNext,
                moduleResolution: ts.ModuleResolutionKind.NodeNext,
                target: ts.ScriptTarget.ES2022,
            },
            reportDiagnostics: true,
        });

        expect(declaration.diagnostics).toEqual([]);
        const declarationSource = ts.createSourceFile(
            'contract.d.ts',
            declaration.outputText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const connectedAccountsImport = declarationSource.statements.find((statement): statement is ts.ImportDeclaration => (
            ts.isImportDeclaration(statement)
            && ts.isStringLiteral(statement.moduleSpecifier)
            && statement.moduleSpecifier.text === '../connectedAccounts.js'
        ));
        const bindings = connectedAccountsImport?.importClause?.namedBindings;
        const importedNames = bindings && ts.isNamedImports(bindings)
            ? bindings.elements.map((binding) => (binding.propertyName ?? binding.name).text)
            : [];
        expect(importedNames).toEqual(expect.arrayContaining([
            'ConnectedAccountMaterializationRequest',
            'ConnectedAccountPurposeId',
        ]));
        expect(declaration.outputText).not.toContain(
            'PluginConnectedAccountMaterializationRequest as ConnectedAccountMaterializationRequest',
        );
    });

    it('keeps its source declaration companion at the public Connected Accounts owner', async () => {
        const declarationPath = fileURLToPath(new URL('../../dist/managed-services/contract.d.ts', import.meta.url));
        const declaration = await readFile(declarationPath, 'utf8');

        expect(declaration).toContain(
            "import type { ConnectedAccountMaterializationRequest, ConnectedAccountPurposeId, ConnectedAccountsService } from '../connectedAccounts.js';",
        );
        expect(declaration).toContain(
            "export type { ConnectedAccountMaterializationRequest } from '../connectedAccounts.js';",
        );
        expect(declaration).not.toContain(
            'PluginConnectedAccountMaterializationRequest as ConnectedAccountMaterializationRequest',
        );
    });

    it('re-exports the canonical Protocol managed-service local-id schema', () => {
        expectTypeOf<ManagedServiceLocalId>().toEqualTypeOf<string>();
        expect(ManagedServiceLocalIdSchema)
            .toBe(ProtocolManagedServiceLocalIdSchema);
    });

    it('projects the canonical managed endpoint URL validator without a plugin-local copy', () => {
        expect(readManagedServiceEndpointUrl).toBe(protocolReadManagedServiceEndpointUrl);
        expectTypeOf<ManagedServiceEndpointUrlRejection>()
            .toEqualTypeOf<ProtocolManagedServiceEndpointUrlRejection>();
        expectTypeOf<ManagedServiceEndpointHostPolicy>()
            .toEqualTypeOf<ProtocolManagedServiceEndpointHostPolicy>();
        expectTypeOf<ManagedServiceEndpointUrlFacts>()
            .toEqualTypeOf<ProtocolManagedServiceEndpointUrlFacts>();
        expectTypeOf<ManagedServiceEndpointUrlResult>()
            .toEqualTypeOf<ProtocolManagedServiceEndpointUrlResult>();
    });

    it('exposes the final service and managed Provider shapes', () => {
        expectTypeOf<ProviderLocalId>().toEqualTypeOf<PluginContributionLocalId>();
        expectTypeOf<ManagedServices>().toHaveProperty('dependencies');
        expectTypeOf<ManagedServices>().toHaveProperty('supervise');
        expectTypeOf<ManagedServiceHandle>().toHaveProperty('observe');
        expectTypeOf<ManagedServiceHandle>().toHaveProperty('request');
        expectTypeOf<ManagedServiceRequest>().toEqualTypeOf<Readonly<{
            pathAndQuery: string;
            method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
            headers?: Readonly<Record<string, string>>;
            body?: Uint8Array;
            interactive?: true;
            timeoutMs?: number;
            signal?: AbortSignal;
        }>>();
        expectTypeOf<ReadableStream<Uint8Array>>()
            .toExtend<NonNullable<ManagedServiceResponse['body']>>();
        expectTypeOf<ManagedServiceSnapshot['state']>().toEqualTypeOf<
            'starting' | 'running' | 'detecting' | 'healthy' | 'unhealthy' | 'stopping' | 'stopped' | 'failed'
        >();
        expectTypeOf<ManagedServiceSnapshot['diagnosticsTruncated']>().toEqualTypeOf<boolean>();
        expectTypeOf<ManagedServiceSnapshot>().not.toHaveProperty('host');
        expectTypeOf<ManagedServiceSnapshot>().not.toHaveProperty('port');
        expectTypeOf<ManagedServiceErrorCode>().toEqualTypeOf<
            | 'plugin_managed_service_spec_invalid'
            | 'plugin_managed_service_spec_conflict'
            | 'plugin_managed_service_capacity_exceeded'
            | 'plugin_managed_service_request_too_large'
            | 'plugin_managed_service_not_reusable'
            | 'plugin_managed_service_unavailable'
            | 'plugin_managed_service_establishment_failed'
            | 'plugin_managed_service_health_timeout'
            | 'plugin_managed_server_termination_incomplete'
            | 'plugin_operation_aborted'
            | 'plugin_managed_provider_result_invalid'
        >();
        expectTypeOf<ManagedServiceSpec>().not.toHaveProperty('launch');
        expectTypeOf<SpawnManagedServiceSpec>().toHaveProperty('requestAuth');
        expectTypeOf<NonNullable<SpawnManagedServiceSpec['requestAuth']>>()
            .toEqualTypeOf<Readonly<{
            kind: 'connectedAccountCapabilityPath' | 'connectedAccountConsumerAccessPath';
            injectEnvironmentKey: string;
        }>>();
        expectTypeOf<AttachManagedServiceSpec>().not.toHaveProperty('requestAuth');
        // Attach accepts the user-recorded credential kind and never a
        // host-minted one: nobody injected a host secret into a server the
        // host did not start.
        expectTypeOf<AttachManagedServiceSpec['clientAccess']>().toEqualTypeOf<
            ManagedServiceAttachClientAccess | undefined
        >();
        expectTypeOf<Extract<
            NonNullable<AttachManagedServiceSpec['clientAccess']>,
            { kind: 'declaredSecretBasic' }
        >>().toEqualTypeOf<Readonly<{
            kind: 'declaredSecretBasic';
            username?: string;
            passwordSecretId: string;
        }>>();
        expectTypeOf<AttachManagedServiceSpec['clientAccess']>()
            .not.toMatchTypeOf<Readonly<{ kind: 'hostBasic' }>>();
        expectTypeOf<ManagedServiceCredentialBinding>().not.toHaveProperty('credential');
        expectTypeOf<ManagedServiceHealthCheck>().not.toHaveProperty('url');
        expectTypeOf<ManagedProviderRuntime>().toHaveProperty('start');
        expectTypeOf<ManagedProviderRuntimeContext>().toHaveProperty('managedServices');
        expectTypeOf<ManagedProviderStartRequest['reason']>().toEqualTypeOf<
            'explicitStartLocal' | 'catalogProbe' | 'sessionDemand'
        >();
        expectTypeOf<ManagedProviderEndpoint>().toHaveProperty('service');
        expectTypeOf<ManagedProviderEndpoint>().not.toHaveProperty('requestAuth');
        expectTypeOf<ManagedProviderEndpoint>().not.toHaveProperty('capabilityPath');
        expectTypeOf<ManagedServiceSnapshot>().not.toHaveProperty('requestAuth');
        expectTypeOf<ManagedServiceSnapshot>().not.toHaveProperty('capabilityPath');
        expectTypeOf<Extract<
            NonNullable<ManagedServiceSpec['clientAccess']>,
            { kind: 'hostBasic' }
        >>().toEqualTypeOf<Readonly<{
            kind: 'hostBasic';
            username: string;
            injectPasswordEnvironmentKey: string;
        }>>();
        expectTypeOf<ProvidersRegistrationApi>().toHaveProperty('register');
        expectTypeOf<Extract<
            ExecSpawnRequest['executable'],
            { kind: 'packaged-runtime-binary' }
        >>().toEqualTypeOf<Readonly<{
            kind: 'packaged-runtime-binary';
            directorySegments: readonly string[];
            executableBaseName: string;
        }>>();
    });
});
