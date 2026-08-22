import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';

import type {
    CapabilitySupport,
    PluginContributionLocalId,
    ProviderApiKeyCredentialRequirementV1 as ProtocolProviderApiKeyCredentialRequirementV1,
    ProviderCatalogCommandFallbackV1 as ProtocolProviderCatalogCommandFallbackV1,
    ProviderCatalogDeclarationV1 as ProtocolProviderCatalogDeclarationV1,
    ProviderCatalogParserV1 as ProtocolProviderCatalogParserV1,
    ProviderCatalogProbeV1 as ProtocolProviderCatalogProbeV1,
    ProviderCompatibilityCapabilitiesV1 as ProtocolProviderCompatibilityCapabilitiesV1,
    ProviderCompatibilityOverrideV1 as ProtocolProviderCompatibilityOverrideV1,
    ProviderConnectionId as ProtocolProviderConnectionId,
    ProviderContributionV1,
    ProviderCredentialDestinationV1 as ProtocolProviderCredentialDestinationV1,
    ProviderCredentialFormatV1 as ProtocolProviderCredentialFormatV1,
    ProviderCredentialTransportV1 as ProtocolProviderCredentialTransportV1,
    ProviderDetectionDescriptorV1 as ProtocolProviderDetectionDescriptorV1,
    ProviderEndpointTemplateV1 as ProtocolProviderEndpointTemplateV1,
    ProviderLegacyProfileMigrationDescriptorV1 as ProtocolProviderLegacyProfileMigrationDescriptorV1,
    ProviderManagedRuntimeDeclarationV1,
    ProviderModelLoadDescriptorV1 as ProtocolProviderModelLoadDescriptorV1,
    ProviderWireProtocol as ProtocolProviderWireProtocol,
    SessionModelSelectionResolutionErrorCode as ProtocolSessionModelSelectionResolutionErrorCode,
} from '@happier-dev/protocol';
import {
    ProviderConnectionIdSchema as ProtocolProviderConnectionIdSchema,
    ProviderContributionV1Schema as ProtocolProviderContributionV1Schema,
    ProviderEndpointUrlSyntaxSchema as ProtocolProviderEndpointUrlSyntaxSchema,
    ProviderPublicHeadersV1Schema as ProtocolProviderPublicHeadersV1Schema,
    SessionModelSelectionResolutionError as ProtocolSessionModelSelectionResolutionError,
    SessionModelSelectionV1Schema as ProtocolSessionModelSelectionV1Schema,
    areProviderContributionKeysEqualV1 as protocolAreProviderContributionKeysEqualV1,
    containsProviderRegisteredSensitiveValue as protocolContainsProviderRegisteredSensitiveValue,
    normalizeProviderCredentialHeaderName as protocolNormalizeProviderCredentialHeaderName,
    resolveProviderBindingCompatibilityWithFingerprintV1 as protocolResolveProviderBindingCompatibilityWithFingerprintV1,
    resolveSessionModelSelectionIntentV1 as protocolResolveSessionModelSelectionIntentV1,
} from '@happier-dev/protocol';
import type {
    DaemonProviderBindingStatusRequestV1,
    DaemonProviderBindingStatusResponseV1,
    DaemonProviderConnectionMutationRequestV1,
    DaemonProviderConnectionMutationResponseV1,
    DaemonProviderConnectionsDescribeRequestV1,
    DaemonProviderConnectionsDescribeResponseV1,
    DaemonProviderModelLoadRequestV1,
    DaemonProviderModelLoadResponseV1,
    DaemonProviderModelProjectionRequestV1,
    DaemonProviderModelProjectionResponseV1,
    DaemonProviderModelsRequestV1,
    DaemonProviderModelsResponseV1,
    DaemonProviderModelSettingsMutationRequestV1,
    DaemonProviderModelSettingsMutationResponseV1,
    DaemonProviderProbeRequestV1,
    DaemonProviderProbeResponseV1,
    DaemonProviderProfileMigrationConfirmRequestV1,
    DaemonProviderProfileMigrationConfirmResponseV1,
    DaemonProviderProfileMigrationConflictConfirmRequestV1,
    DaemonProviderProfileMigrationConflictConfirmResponseV1,
    DaemonProviderProfileMigrationPreviewRequestV1,
    DaemonProviderProfileMigrationPreviewResponseV1,
} from '@happier-dev/protocol/rpc';

import type {
    ManagedProviderEndpoint as SourceManagedProviderEndpoint,
    ManagedProviderRuntime as SourceManagedProviderRuntime,
    ManagedProviderRuntimeContext as SourceManagedProviderRuntimeContext,
    ManagedProviderStartRequest as SourceManagedProviderStartRequest,
    ProvidersRegistrationApi as SourceProvidersRegistrationApi,
} from '../managed-services/contract.js';
import type { PluginServices } from '../services/index.js';
import * as providerProjection from './projections.js';
import type {
    ManagedProviderEndpoint,
    ManagedProviderRuntime,
    ManagedProviderRuntimeContext,
    ManagedProviderStartRequest,
    ProviderBindingStatusRequest,
    ProviderBindingStatusResult,
    ProviderApiKeyCredentialRequirementV1,
    ProviderCapabilitySupport,
    ProviderCatalogCommandFallbackV1,
    ProviderCatalogDeclarationV1,
    ProviderCatalogParserId,
    ProviderCatalogProbeV1,
    ProviderCompatibilityCapabilitiesV1,
    ProviderCompatibilityOverrideV1,
    ProviderConnectionId,
    ProviderConnectionMutationRequest,
    ProviderConnectionMutationResult,
    ProviderConnectionsDescribeRequest,
    ProviderConnectionsDescribeResult,
    ProviderContribution,
    ProviderCredentialDestinationV1,
    ProviderCredentialFormatV1,
    ProviderCredentialTransportV1,
    ProviderDetectionDescriptorV1,
    ProviderEndpointTemplateV1,
    ProviderLegacyProfileMigrationDescriptorV1,
    ProviderLocalId,
    ProviderManagedRuntimeDeclaration,
    ProviderModelLoadRequest,
    ProviderModelLoadResult,
    ProviderModelLoadDescriptorV1,
    ProviderModelProjectionRequest,
    ProviderModelProjectionResult,
    ProviderModelsRequest,
    ProviderModelsResult,
    ProviderModelSettingsMutationRequest,
    ProviderModelSettingsMutationResult,
    ProviderProbeRequest,
    ProviderProbeResult,
    ProviderProfileMigrationConfirmRequest,
    ProviderProfileMigrationConfirmResult,
    ProviderProfileMigrationConflictConfirmRequest,
    ProviderProfileMigrationConflictConfirmResult,
    ProviderProfileMigrationPreviewRequest,
    ProviderProfileMigrationPreviewResult,
    ProviderWireProtocol,
    ProvidersRegistrationApi,
    ProvidersService,
    SessionModelSelectionResolutionErrorCode,
} from './projections.js';

const PROVIDER_EXPORTS = [
    'AgentProviderRequirementsV1',
    'ManagedProviderEndpoint',
    'ManagedProviderRuntime',
    'ManagedProviderRuntimeContext',
    'ManagedProviderStartRequest',
    'ProviderBindingCompatibilityResolutionInput',
    'ProviderBindingStatusRequest',
    'ProviderBindingStatusResult',
    'ProviderApiKeyCredentialRequirementV1',
    'ProviderCapabilitySupport',
    'ProviderCatalogCommandFallbackV1',
    'ProviderCatalogDeclarationV1',
    'BundledProviderCatalogParserId',
    'BundledProviderWireProtocol',
    'ProviderCatalogParseResult',
    'ProviderCatalogParsedModel',
    'ProviderCatalogParsedModelLoadState',
    'ProviderCatalogParser',
    'ProviderCatalogParserId',
    'ProviderCatalogProbeV1',
    'ProviderCatalogService',
    'ProviderCompatibilityCapabilitiesV1',
    'ProviderCompatibilityOverrideV1',
    'ProviderConnectionId',
    'ProviderConnectionIdSchema',
    'ProviderConnectionMutationRequest',
    'ProviderConnectionMutationResult',
    'ProviderConnectionsDescribeRequest',
    'ProviderConnectionsDescribeResult',
    'ProviderConnectionsService',
    'ProviderContribution',
    'ProviderContributionV1Schema',
    'ProviderCredentialDestinationV1',
    'ProviderCredentialFormatV1',
    'ProviderCredentialTransportV1',
    'ProviderDetectionDescriptorV1',
    'ProviderEndpointTemplateV1',
    'ProviderEndpointUrlSyntaxSchema',
    'ProviderLegacyProfileMigrationDescriptorV1',
    'ProviderLocalId',
    'ProviderManagedRuntimeDeclaration',
    'ProviderMigrationsService',
    'ProviderModelLoadRequest',
    'ProviderModelLoadResult',
    'ProviderModelLoadDescriptorV1',
    'ProviderModelLoadStateV1',
    'ProviderModelProjectionRequest',
    'ProviderModelProjectionResult',
    'ProviderModelsRequest',
    'ProviderModelsResult',
    'ProviderModelSettingsMutationRequest',
    'ProviderModelSettingsMutationResult',
    'ProviderProbeRequest',
    'ProviderProbeResult',
    'ProviderProfileMigrationConfirmRequest',
    'ProviderProfileMigrationConfirmResult',
    'ProviderProfileMigrationConflictConfirmRequest',
    'ProviderProfileMigrationConflictConfirmResult',
    'ProviderProfileMigrationPreviewRequest',
    'ProviderProfileMigrationPreviewResult',
    'ProviderPublicHeadersV1Schema',
    'ProviderWireProtocol',
    'ProvidersRegistrationApi',
    'ProvidersService',
    'ResolveProviderBindingCompatibilityInputV1',
    'SessionModelSelectionIntentResolutionInput',
    'SessionModelSelectionResolutionError',
    'SessionModelSelectionResolutionErrorCode',
    'SessionModelSelectionV1Schema',
    'areProviderContributionKeysEqualV1',
    'containsProviderRegisteredSensitiveValue',
    'normalizeProviderCredentialHeaderName',
    'resolveProviderBindingCompatibilityWithFingerprintV1',
    'resolveSessionModelSelectionIntentV1',
] as const;

const PROVIDER_RUNTIME_EXPORTS = [
    'ProviderConnectionIdSchema',
    'ProviderContributionV1Schema',
    'ProviderEndpointUrlSyntaxSchema',
    'ProviderPublicHeadersV1Schema',
    'SessionModelSelectionResolutionError',
    'SessionModelSelectionV1Schema',
    'areProviderContributionKeysEqualV1',
    'containsProviderRegisteredSensitiveValue',
    'normalizeProviderCredentialHeaderName',
    'resolveProviderBindingCompatibilityWithFingerprintV1',
    'resolveSessionModelSelectionIntentV1',
] as const;

const MANAGED_PROVIDER_EXPORTS = [
    'ManagedProviderEndpoint',
    'ManagedProviderRuntime',
    'ManagedProviderRuntimeContext',
    'ManagedProviderStartRequest',
    'ProviderLocalId',
    'ProvidersRegistrationApi',
] as const;

type WithoutHostMachineIdentity<T> = T extends Readonly<{ machineId: unknown }>
    ? Omit<T, 'machineId'>
    : never;

type DaemonProviderStartLocalRequest = Extract<
    DaemonProviderConnectionMutationRequestV1,
    { action: 'startLocal' }
>;

type SemanticProviderConnectionMutationRequest =
    | WithoutHostMachineIdentity<Exclude<
        DaemonProviderConnectionMutationRequestV1,
        DaemonProviderStartLocalRequest
    >>
    | Readonly<Omit<
        DaemonProviderStartLocalRequest,
        'machineId' | 'connectionId'
    >>;

function createSdkProgram(): ts.Program {
    const configPath = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic(diagnostic) {
            throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
    });
    if (!parsed) throw new Error(`Unable to parse ${configPath}`);
    return ts.createProgram({
        rootNames: parsed.fileNames,
        options: parsed.options,
        projectReferences: parsed.projectReferences,
    });
}

function moduleExportNames(program: ts.Program, relativePath: string): readonly string[] {
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    const sourceFile = program.getSourceFile(`${packageRoot}/${relativePath}`);
    if (!sourceFile) throw new Error(`Missing source module: ${relativePath}`);
    const moduleSymbol = program.getTypeChecker().getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) throw new Error(`Missing module symbol: ${relativePath}`);
    return program.getTypeChecker().getExportsOfModule(moduleSymbol)
        .map((symbol) => symbol.name)
        .sort();
}

function importModuleForBinding(
    program: ts.Program,
    relativePath: string,
    importedName: string,
): string | undefined {
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    const sourceFile = program.getSourceFile(`${packageRoot}/${relativePath}`);
    if (!sourceFile) throw new Error(`Missing source module: ${relativePath}`);
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)
            || !statement.importClause?.namedBindings
            || !ts.isNamedImports(statement.importClause.namedBindings)
            || !ts.isStringLiteral(statement.moduleSpecifier)) {
            continue;
        }
        if (statement.importClause.namedBindings.elements.some((element) => (
            element.name.text === importedName
        ))) {
            return statement.moduleSpecifier.text;
        }
    }
    return undefined;
}

function moduleExportCanonicalDeclarationPaths(
    program: ts.Program,
    relativePath: string,
    exportName: string,
): readonly string[] {
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
    const sourceFile = program.getSourceFile(`${packageRoot}/${relativePath}`);
    if (!sourceFile) throw new Error(`Missing source module: ${relativePath}`);
    const checker = program.getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) throw new Error(`Missing module symbol: ${relativePath}`);
    const exportedSymbol = checker.getExportsOfModule(moduleSymbol)
        .find((symbol) => symbol.name === exportName);
    if (!exportedSymbol) throw new Error(`Missing export: ${relativePath}#${exportName}`);
    const canonicalSymbol = exportedSymbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exportedSymbol)
        : exportedSymbol;
    return (canonicalSymbol.declarations ?? [])
        .map((declaration) => declaration.getSourceFile().fileName.replace(`${packageRoot}/`, ''))
        .sort();
}

type ProjectionTypes = [
    providerProjection.ManagedProviderEndpoint,
    providerProjection.ManagedProviderRuntime,
    providerProjection.ManagedProviderRuntimeContext,
    providerProjection.ManagedProviderStartRequest,
    providerProjection.ProviderBindingCompatibilityResolutionInput,
    providerProjection.ProviderBindingStatusRequest,
    providerProjection.ProviderBindingStatusResult,
    providerProjection.ProviderApiKeyCredentialRequirementV1,
    providerProjection.ProviderCapabilitySupport,
    providerProjection.ProviderCatalogCommandFallbackV1,
    providerProjection.ProviderCatalogDeclarationV1,
    providerProjection.ProviderCatalogParserId,
    providerProjection.ProviderCatalogProbeV1,
    providerProjection.ProviderCatalogService,
    providerProjection.ProviderCompatibilityCapabilitiesV1,
    providerProjection.ProviderCompatibilityOverrideV1,
    providerProjection.ProviderConnectionId,
    providerProjection.ProviderConnectionMutationRequest,
    providerProjection.ProviderConnectionMutationResult,
    providerProjection.ProviderConnectionsDescribeRequest,
    providerProjection.ProviderConnectionsDescribeResult,
    providerProjection.ProviderConnectionsService,
    providerProjection.ProviderContribution,
    providerProjection.ProviderCredentialDestinationV1,
    providerProjection.ProviderCredentialFormatV1,
    providerProjection.ProviderCredentialTransportV1,
    providerProjection.ProviderDetectionDescriptorV1,
    providerProjection.ProviderEndpointTemplateV1,
    providerProjection.ProviderLegacyProfileMigrationDescriptorV1,
    providerProjection.ProviderLocalId,
    providerProjection.ProviderManagedRuntimeDeclaration,
    providerProjection.ProviderMigrationsService,
    providerProjection.ProviderModelLoadRequest,
    providerProjection.ProviderModelLoadResult,
    providerProjection.ProviderModelLoadDescriptorV1,
    providerProjection.ProviderModelProjectionRequest,
    providerProjection.ProviderModelProjectionResult,
    providerProjection.ProviderModelsRequest,
    providerProjection.ProviderModelsResult,
    providerProjection.ProviderModelSettingsMutationRequest,
    providerProjection.ProviderModelSettingsMutationResult,
    providerProjection.ProviderProbeRequest,
    providerProjection.ProviderProbeResult,
    providerProjection.ProviderProfileMigrationConfirmRequest,
    providerProjection.ProviderProfileMigrationConfirmResult,
    providerProjection.ProviderProfileMigrationConflictConfirmRequest,
    providerProjection.ProviderProfileMigrationConflictConfirmResult,
    providerProjection.ProviderProfileMigrationPreviewRequest,
    providerProjection.ProviderProfileMigrationPreviewResult,
    providerProjection.ProviderWireProtocol,
    providerProjection.ProvidersRegistrationApi,
    providerProjection.ProvidersService,
    providerProjection.SessionModelSelectionIntentResolutionInput,
    providerProjection.SessionModelSelectionResolutionErrorCode,
];
void (null as unknown as ProjectionTypes);

describe('final Provider source projection', () => {
    it('assembles the Plugin Services Provider context from the final projection', () => {
        const program = createSdkProgram();

        expect(importModuleForBinding(program, 'src/services/index.ts', 'ProvidersService'))
            .toBe('../providers/projections.js');
        expectTypeOf<PluginServices['providers']>().toEqualTypeOf<ProvidersService>();
    }, 120_000);

    it('publishes managed Provider runtime contracts only from the final Provider entrypoint', () => {
        const program = createSdkProgram();
        const managedProviderNames = new Set<string>(MANAGED_PROVIDER_EXPORTS);
        expect(moduleExportNames(program, 'src/providers.ts').filter((name) => (
            managedProviderNames.has(name)
        ))).toEqual([]);
        expect(moduleExportNames(program, 'src/managed-services/index.ts').filter((name) => (
            managedProviderNames.has(name)
        ))).toEqual([]);
        expect(moduleExportNames(program, 'src/providers/index.ts').filter((name) => (
            managedProviderNames.has(name)
        ))).toEqual([...MANAGED_PROVIDER_EXPORTS].sort());
    }, 120_000);

    it('has the exact approved Provider symbol census', () => {
        expect(Object.keys(providerProjection).sort())
            .toEqual([...PROVIDER_RUNTIME_EXPORTS].sort());
        const program = createSdkProgram();
        expect(moduleExportNames(program, 'src/providers/projections.ts'))
            .toEqual([...PROVIDER_EXPORTS].sort());
    }, 120_000);

    it('aliases the canonical declaration and managed-runtime identities', () => {
        expectTypeOf<ProviderContribution>().toEqualTypeOf<ProviderContributionV1>();
        expectTypeOf<ProviderConnectionId>().toEqualTypeOf<ProtocolProviderConnectionId>();
        expectTypeOf<ProviderManagedRuntimeDeclaration>()
            .toEqualTypeOf<ProviderManagedRuntimeDeclarationV1>();
        expectTypeOf<ProviderLocalId>().toEqualTypeOf<PluginContributionLocalId>();
        expectTypeOf<ProviderCapabilitySupport>().toEqualTypeOf<CapabilitySupport>();
        expectTypeOf<ProviderApiKeyCredentialRequirementV1>()
            .toEqualTypeOf<ProtocolProviderApiKeyCredentialRequirementV1>();
        expectTypeOf<ProviderCatalogCommandFallbackV1>()
            .toEqualTypeOf<ProtocolProviderCatalogCommandFallbackV1>();
        expectTypeOf<ProviderCatalogDeclarationV1>()
            .toEqualTypeOf<ProtocolProviderCatalogDeclarationV1>();
        expectTypeOf<ProviderCatalogParserId>()
            .toEqualTypeOf<ProtocolProviderCatalogParserV1>();
        expectTypeOf<ProviderCatalogProbeV1>()
            .toEqualTypeOf<ProtocolProviderCatalogProbeV1>();
        expectTypeOf<ProviderCompatibilityCapabilitiesV1>()
            .toEqualTypeOf<ProtocolProviderCompatibilityCapabilitiesV1>();
        expectTypeOf<ProviderCompatibilityOverrideV1>()
            .toEqualTypeOf<ProtocolProviderCompatibilityOverrideV1>();
        expectTypeOf<ProviderCredentialDestinationV1>()
            .toEqualTypeOf<ProtocolProviderCredentialDestinationV1>();
        expectTypeOf<ProviderCredentialFormatV1>()
            .toEqualTypeOf<ProtocolProviderCredentialFormatV1>();
        expectTypeOf<ProviderCredentialTransportV1>()
            .toEqualTypeOf<ProtocolProviderCredentialTransportV1>();
        expectTypeOf<ProviderDetectionDescriptorV1>()
            .toEqualTypeOf<ProtocolProviderDetectionDescriptorV1>();
        expectTypeOf<ProviderEndpointTemplateV1>()
            .toEqualTypeOf<ProtocolProviderEndpointTemplateV1>();
        expectTypeOf<ProviderLegacyProfileMigrationDescriptorV1>()
            .toEqualTypeOf<ProtocolProviderLegacyProfileMigrationDescriptorV1>();
        expectTypeOf<ProviderModelLoadDescriptorV1>()
            .toEqualTypeOf<ProtocolProviderModelLoadDescriptorV1>();
        expectTypeOf<ProviderWireProtocol>()
            .toEqualTypeOf<ProtocolProviderWireProtocol>();
        expectTypeOf<SessionModelSelectionResolutionErrorCode>()
            .toEqualTypeOf<ProtocolSessionModelSelectionResolutionErrorCode>();
        expectTypeOf<ManagedProviderEndpoint>()
            .toEqualTypeOf<SourceManagedProviderEndpoint>();
        expectTypeOf<ManagedProviderRuntime>()
            .toEqualTypeOf<SourceManagedProviderRuntime>();
        expectTypeOf<ManagedProviderRuntimeContext>()
            .toEqualTypeOf<SourceManagedProviderRuntimeContext>();
        expectTypeOf<ManagedProviderStartRequest>()
            .toEqualTypeOf<SourceManagedProviderStartRequest>();
        expectTypeOf<ProvidersRegistrationApi>()
            .toEqualTypeOf<SourceProvidersRegistrationApi>();
    });

    it('uses the managed-services declaration as the sole managed Provider start-request identity', () => {
        const program = createSdkProgram();
        expect(moduleExportCanonicalDeclarationPaths(
            program,
            'src/providers/projections.ts',
            'ManagedProviderStartRequest',
        )).toEqual(['src/managed-services/contract.ts']);
    }, 120_000);

    it('re-exports canonical Provider runtime values by identity', () => {
        expect(providerProjection.ProviderConnectionIdSchema)
            .toBe(ProtocolProviderConnectionIdSchema);
        expect(providerProjection.ProviderContributionV1Schema)
            .toBe(ProtocolProviderContributionV1Schema);
        expect(providerProjection.ProviderEndpointUrlSyntaxSchema)
            .toBe(ProtocolProviderEndpointUrlSyntaxSchema);
        expect(providerProjection.ProviderPublicHeadersV1Schema)
            .toBe(ProtocolProviderPublicHeadersV1Schema);
        expect(providerProjection.SessionModelSelectionResolutionError)
            .toBe(ProtocolSessionModelSelectionResolutionError);
        expect(providerProjection.SessionModelSelectionV1Schema)
            .toBe(ProtocolSessionModelSelectionV1Schema);
        expect(providerProjection.areProviderContributionKeysEqualV1)
            .toBe(protocolAreProviderContributionKeysEqualV1);
        expect(providerProjection.containsProviderRegisteredSensitiveValue)
            .toBe(protocolContainsProviderRegisteredSensitiveValue);
        expect(providerProjection.normalizeProviderCredentialHeaderName)
            .toBe(protocolNormalizeProviderCredentialHeaderName);
        expect(providerProjection.resolveProviderBindingCompatibilityWithFingerprintV1)
            .toBe(protocolResolveProviderBindingCompatibilityWithFingerprintV1);
        expect(providerProjection.resolveSessionModelSelectionIntentV1)
            .toBe(protocolResolveSessionModelSelectionIntentV1);
        expectTypeOf<typeof providerProjection.resolveProviderBindingCompatibilityWithFingerprintV1>()
            .toMatchTypeOf<typeof protocolResolveProviderBindingCompatibilityWithFingerprintV1>();
        expectTypeOf<typeof protocolResolveProviderBindingCompatibilityWithFingerprintV1>()
            .toMatchTypeOf<typeof providerProjection.resolveProviderBindingCompatibilityWithFingerprintV1>();
        expectTypeOf(providerProjection.resolveSessionModelSelectionIntentV1)
            .toEqualTypeOf(protocolResolveSessionModelSelectionIntentV1);
    });

    it('projects only host-neutral semantic requests and canonical results', () => {
        expectTypeOf<ProviderConnectionsDescribeRequest>()
            .toEqualTypeOf<WithoutHostMachineIdentity<DaemonProviderConnectionsDescribeRequestV1>>();
        expectTypeOf<ProviderConnectionsDescribeResult>()
            .toEqualTypeOf<DaemonProviderConnectionsDescribeResponseV1>();
        expectTypeOf<ProviderConnectionMutationRequest>()
            .toEqualTypeOf<SemanticProviderConnectionMutationRequest>();
        expectTypeOf<ProviderConnectionMutationResult>()
            .toEqualTypeOf<DaemonProviderConnectionMutationResponseV1>();
        expectTypeOf<ProviderBindingStatusRequest>()
            .toEqualTypeOf<WithoutHostMachineIdentity<DaemonProviderBindingStatusRequestV1>>();
        expectTypeOf<ProviderBindingStatusResult>()
            .toEqualTypeOf<DaemonProviderBindingStatusResponseV1>();
        expectTypeOf<ProviderProbeRequest>()
            .toEqualTypeOf<WithoutHostMachineIdentity<DaemonProviderProbeRequestV1>>();
        expectTypeOf<ProviderProbeResult>().toEqualTypeOf<DaemonProviderProbeResponseV1>();
        expectTypeOf<ProviderModelsRequest>()
            .toEqualTypeOf<WithoutHostMachineIdentity<DaemonProviderModelsRequestV1>>();
        expectTypeOf<ProviderModelsResult>().toEqualTypeOf<DaemonProviderModelsResponseV1>();
        expectTypeOf<ProviderModelLoadRequest>()
            .toEqualTypeOf<WithoutHostMachineIdentity<DaemonProviderModelLoadRequestV1>>();
        expectTypeOf<ProviderModelLoadResult>()
            .toEqualTypeOf<DaemonProviderModelLoadResponseV1>();
        expectTypeOf<ProviderModelProjectionRequest>()
            .toEqualTypeOf<WithoutHostMachineIdentity<DaemonProviderModelProjectionRequestV1>>();
        expectTypeOf<ProviderModelProjectionResult>()
            .toEqualTypeOf<DaemonProviderModelProjectionResponseV1>();
        expectTypeOf<ProviderModelSettingsMutationRequest>()
            .toEqualTypeOf<WithoutHostMachineIdentity<DaemonProviderModelSettingsMutationRequestV1>>();
        expectTypeOf<ProviderModelSettingsMutationResult>()
            .toEqualTypeOf<DaemonProviderModelSettingsMutationResponseV1>();
        expectTypeOf<ProviderProfileMigrationPreviewRequest>()
            .toEqualTypeOf<WithoutHostMachineIdentity<DaemonProviderProfileMigrationPreviewRequestV1>>();
        expectTypeOf<ProviderProfileMigrationPreviewResult>()
            .toEqualTypeOf<DaemonProviderProfileMigrationPreviewResponseV1>();
        expectTypeOf<ProviderProfileMigrationConfirmRequest>()
            .toEqualTypeOf<WithoutHostMachineIdentity<DaemonProviderProfileMigrationConfirmRequestV1>>();
        expectTypeOf<ProviderProfileMigrationConfirmResult>()
            .toEqualTypeOf<DaemonProviderProfileMigrationConfirmResponseV1>();
        expectTypeOf<ProviderProfileMigrationConflictConfirmRequest>()
            .toEqualTypeOf<WithoutHostMachineIdentity<DaemonProviderProfileMigrationConflictConfirmRequestV1>>();
        expectTypeOf<ProviderProfileMigrationConflictConfirmResult>()
            .toEqualTypeOf<DaemonProviderProfileMigrationConflictConfirmResponseV1>();
    });

    it('keeps the exact eleven-operation Provider service shape', () => {
        expectTypeOf<ProvidersService['connections']['describe']>()
            .parameter(0).toEqualTypeOf<ProviderConnectionsDescribeRequest>();
        expectTypeOf<ProvidersService['connections']['mutate']>()
            .parameter(0).toEqualTypeOf<ProviderConnectionMutationRequest>();
        expectTypeOf<ProvidersService['connections']['bindingStatus']>()
            .parameter(0).toEqualTypeOf<ProviderBindingStatusRequest>();
        expectTypeOf<ProvidersService['catalog']['probe']>()
            .parameter(0).toEqualTypeOf<ProviderProbeRequest>();
        expectTypeOf<ProvidersService['catalog']['listModels']>()
            .parameter(0).toEqualTypeOf<ProviderModelsRequest>();
        expectTypeOf<ProvidersService['catalog']['setModelLoad']>()
            .parameter(0).toEqualTypeOf<ProviderModelLoadRequest>();
        expectTypeOf<ProvidersService['catalog']['projectModels']>()
            .parameter(0).toEqualTypeOf<ProviderModelProjectionRequest>();
        expectTypeOf<ProvidersService['catalog']['mutateModelSettings']>()
            .parameter(0).toEqualTypeOf<ProviderModelSettingsMutationRequest>();
        expectTypeOf<ProvidersService['migrations']['preview']>()
            .parameter(0).toEqualTypeOf<ProviderProfileMigrationPreviewRequest>();
        expectTypeOf<ProvidersService['migrations']['confirm']>()
            .parameter(0).toEqualTypeOf<ProviderProfileMigrationConfirmRequest>();
        expectTypeOf<ProvidersService['migrations']['confirmConflict']>()
            .parameter(0).toEqualTypeOf<ProviderProfileMigrationConflictConfirmRequest>();
    });
});
