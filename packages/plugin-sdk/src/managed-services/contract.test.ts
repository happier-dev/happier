import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';

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
            timeoutMs?: number;
            signal?: AbortSignal;
        }>>();
        expectTypeOf<ManagedServiceResponse>().toEqualTypeOf<Readonly<{
            ok: boolean;
            status: number;
            statusText: string;
            headers: Readonly<Record<string, string>>;
            body: ReadableStream<Uint8Array> | null;
        }>>();
        expectTypeOf<ManagedServiceSnapshot['state']>().toEqualTypeOf<
            'starting' | 'detecting' | 'healthy' | 'unhealthy' | 'stopping' | 'stopped' | 'failed'
        >();
        expectTypeOf<ManagedServiceSnapshot['diagnosticsTruncated']>().toEqualTypeOf<boolean>();
        expectTypeOf<ManagedServiceSnapshot>().not.toHaveProperty('host');
        expectTypeOf<ManagedServiceSnapshot>().not.toHaveProperty('port');
        expectTypeOf<ManagedServiceErrorCode>().toEqualTypeOf<
            | 'plugin_managed_service_spec_invalid'
            | 'plugin_managed_service_spec_conflict'
            | 'plugin_managed_service_capacity_exceeded'
            | 'plugin_managed_service_not_reusable'
            | 'plugin_managed_service_unavailable'
            | 'plugin_managed_service_establishment_failed'
            | 'plugin_managed_service_health_timeout'
            | 'plugin_operation_aborted'
            | 'plugin_managed_provider_result_invalid'
        >();
        expectTypeOf<ManagedServiceSpec>().not.toHaveProperty('launch');
        expectTypeOf<SpawnManagedServiceSpec>().toHaveProperty('requestAuth');
        expectTypeOf<NonNullable<SpawnManagedServiceSpec['requestAuth']>>()
            .toEqualTypeOf<Readonly<{
            kind: 'connectedAccountCapabilityPath';
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
