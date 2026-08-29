import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';

import type {
    PluginRuntimeRegistration as PackagePluginRuntimeRegistration,
} from '@happier-dev/plugin-sdk/host/registration';
import type {
    PluginMachineExecutionOriginV1 as ProtocolPluginMachineExecutionOriginV1,
    PluginMachineMaterializationRefV1 as ProtocolPluginMachineMaterializationRefV1,
} from '@happier-dev/protocol';
/* @sdk-negative-type-case:src-publicPackageExports-test-ts-33:LS0gdGhlIGNhbm9uaWNhbCB2YWxpZGF0b3IgaXMgY2hlY2tlZCBKYXZhU2NyaXB0IHdpdGhvdXQgZW1pdHRlZCBkZWNsYXJhdGlvbnMu:aW1wb3J0IHsgcmVhZFZhbGlkYXRlZEFwaVN1cmZhY2VJbnZlbnRvcnlJZlByZXNlbnQgfSBmcm9tICcuLi9zY3JpcHRzL2FwaVN1cmZhY2UubWpzJzs */
const apiSurfaceValidatorModulePath: string = '../scripts/apiSurface.mjs';
const readValidatedApiSurfaceInventoryIfPresent = (
    await import(apiSurfaceValidatorModulePath) as Readonly<{
        readValidatedApiSurfaceInventoryIfPresent(
            url: URL,
        ): Promise<Readonly<{ status: 'available'; inventory: never } | { status: 'missing' }>>;
    }>
).readValidatedApiSurfaceInventoryIfPresent; /* @sdk-negative-type-case-end */

import type {
    PluginRuntimeRegistration as SourcePluginRuntimeRegistration,
} from './host/registration/index.js';
import type {
    PluginMachineMaterializationRefV1 as RootPluginMachineMaterializationRefV1,
} from './index.js';
import type {
    PluginMachineExecutionOriginV1 as ActionsPluginMachineExecutionOriginV1,
} from './actions/index.js';
import * as rootPublicApi from './index.js';
import * as connectedAccountManifestApi from './manifest/connectedAccountDescriptors.js';
import {
    projectAuthorSurfaceContract,
    requireApiSurfaceInventory,
} from './normalSurfaceContract.js';
import * as runtimePublicApi from './runtime/index.js';
import * as testingPublicApi from './testing/index.js';

type PackageExportTarget = Readonly<{
    types: string;
    browser?: string;
    default: string;
}>;
type ApiSurfaceInventory = Readonly<{
    entrypoints: readonly Readonly<{
        specifier: string;
        sourceModule: string;
        visibility: 'author' | 'host';
        conditions: Readonly<Record<string, string>>;
    }>[];
    symbols: readonly Readonly<{
        specifier: string;
        exportName: string;
        kind: 'type' | 'value';
        sourceModule: string;
        sourceExport: string;
        realm: 'any' | 'browser' | 'react-native' | 'client' | 'daemon' | 'build';
        replacement?: string;
        removalCondition?: string;
    }>[];
}>;
type PluginSdkPackageJson = Readonly<{
    version: string;
    private: boolean;
    dependencies: Readonly<Record<string, string>>;
    devDependencies: Readonly<Record<string, string>>;
    exports: Readonly<Record<string, PackageExportTarget>>;
    happier: Readonly<{
        publicSdkRelease: Readonly<{
            posture: string;
            supportPolicy: string;
            externalPublicationRequiresApproval: boolean;
        }>;
    }>;
}>;

const apiSurfaceInventoryRead: Readonly<
    | { status: 'available'; inventory: ApiSurfaceInventory }
    | { status: 'missing' }
> = await readValidatedApiSurfaceInventoryIfPresent(
    new URL('../api-surface.json', import.meta.url),
);
const apiSurfaceInventory = apiSurfaceInventoryRead.status === 'available'
    ? apiSurfaceInventoryRead.inventory
    : undefined;
// Publication inventory is required by every ordinary/package surface run.
// The explicit nonwriting source lane defers only these generated-currentness
// assertions to the sole ordered publisher.
const inventoryIt = process.env.HAPPIER_PLUGIN_SDK_SOURCE_ONLY === '1' ? it.skip : it;

const protocolExports = [
    'PluginJsonSchema',
    'ProtocolArrayOptions',
    'ProtocolCollectionOpaqueCursorV1',
    'ProtocolCollectionOpaqueCursorV1Schema',
    'ProtocolComposableSchema',
    'ProtocolComposerReferenceResolutionV1Schema',
    'ProtocolJsonValue',
    'ProtocolJsonValueOptions',
    'ProtocolNumberOptions',
    'ProtocolObjectEvolutionPolicy',
    'ProtocolObjectOptions',
    'ProtocolSchemaInput',
    'ProtocolSchemaOutput',
    'ProtocolSchemaSafeParseResult',
    'ProtocolStringOptions',
    'ProtocolUniqueJsonArrayOptions',
    'ProtocolUtf8StringOptions',
    'ProtocolValidationError',
    'ProtocolValidationIssue',
    'defineProtocolArray',
    'defineProtocolJsonValue',
    'defineProtocolLiteral',
    'defineProtocolNumber',
    'defineProtocolObject',
    'defineProtocolString',
    'defineProtocolUnion',
    'defineProtocolUtf8String',
    'defineProtocolUniqueArray',
    'pluginJsonValuesEqual',
] as const;

const contributionExports = [
    'ContributionActionDangerLevel',
    'ContributionActionSurface',
    'ContributionAuthorDefinition',
    'ContributionAuthorTargets',
    'ContributionContributeInput',
    'ContributionOperationBindings',
    'ContributionOperationDefinition',
    'ContributionOperationRole',
    'ContributionPointAuthorDefinition',
    'ContributionPointOptions',
    'ContributionProtocol',
    'ContributionProtocolDefinition',
    'ContributionProtocolManifest',
    'ContributionSurfaceBinding',
    'ContributionSurfaceBindings',
    'ContributionSurfaceDefinition',
    'ContributionSurfaceFallback',
    'ContributionSurfaceHandle',
    'ContributionSurfaceIcon',
    'ContributionSurfaceLocalizedString',
    'ContributionSurfaceNode',
    'ContributionSurfaceNodeInput',
    'ContributionSurfacePresentation',
    'ContributionSurfaceRole',
    'DefinedContributionPointProtocolMap',
    'DescriptorFields',
    'IsRequiredSurfaceDefinition',
    'PluginTargetedContributionSelectionV1',
    'PluginTargetedContributionSelectionV1Schema',
    'PublicContributionProtocol',
    'PublicContributionProtocols',
    'RequiredSurfaceRoles',
    'SchemaInput',
    'SchemaOutput',
    'SurfaceFields',
    'defineContributionPoint',
    'defineContributionProtocol',
] as const;

const protocolAuthoringSignatureHelperExports = [
    'ContributionContributeInput',
    'ContributionOperationRole',
    'ContributionPointOptions',
    'ContributionProtocolManifest',
    'DescriptorFields',
    'DefinedContributionPointProtocolMap',
    'IsRequiredSurfaceDefinition',
    'PublicContributionProtocol',
    'PublicContributionProtocols',
    'RequiredSurfaceRoles',
    'SchemaInput',
    'SchemaOutput',
    'SurfaceFields',
] as const;

function readAuthorSurfaceContract() {
    return projectAuthorSurfaceContract(readApiSurfaceInventory());
}

function readApiSurfaceInventory(): ApiSurfaceInventory {
    return requireApiSurfaceInventory(apiSurfaceInventoryRead);
}

async function readNamedBarrelExports(sourceModule: string): Promise<readonly string[]> {
    const sourceText = await readFile(new URL(`../${sourceModule}`, import.meta.url), 'utf8');
    const sourceFile = ts.createSourceFile(
        sourceModule,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
    return sourceFile.statements.flatMap((statement) => {
        if (!ts.isExportDeclaration(statement) || !statement.exportClause) return [];
        if (!ts.isNamedExports(statement.exportClause)) return [];
        return statement.exportClause.elements.map((element) => element.name.text);
    });
}

async function expectCanonicalInventoryBarrelClosure(
    specifier: string,
    required: readonly string[],
    forbidden: readonly string[] = [],
): Promise<void> {
    const inventory = requireApiSurfaceInventory(apiSurfaceInventoryRead);
    const entrypoint = inventory.entrypoints.find((entry) => entry.specifier === specifier);
    if (!entrypoint) throw new Error(`API inventory is missing ${specifier}`);
    const inventoryExports = inventory.symbols
        .filter((symbol) => symbol.specifier === specifier)
        .map((symbol) => symbol.exportName)
        .sort();

    expect([...(await readNamedBarrelExports(entrypoint.sourceModule))].sort())
        .toEqual(inventoryExports);
    expect(inventoryExports).toEqual(expect.arrayContaining([...required]));
    for (const retired of forbidden) expect(inventoryExports).not.toContain(retired);
}

function sourceModuleForRuntimeCondition(target: string): string {
    return target
        .replace(/^\.\/dist\//u, 'src/')
        .replace(/\.js$/u, '.ts');
}

describe('CORE-A curated package exports', () => {
    it('requires the post-cutover package-owned API inventory', () => {
        expect(apiSurfaceInventory).toBeDefined();
    });

    inventoryIt('matches package exports to the validated package-owned inventory', async () => {
        const packageJson = JSON.parse(
            await readFile(new URL('../package.json', import.meta.url), 'utf8'),
        ) as PluginSdkPackageJson;

        expect(packageJson.exports).toEqual(Object.fromEntries(
            apiSurfaceInventory?.entrypoints.map((entrypoint) => [
                entrypoint.specifier,
                entrypoint.conditions,
            ]) ?? [],
        ));
    });

    it('keeps retired package paths and host-private values off author surfaces', async () => {
        const packageJson = JSON.parse(
            await readFile(new URL('../package.json', import.meta.url), 'utf8'),
        ) as PluginSdkPackageJson;

        expect(Object.keys(packageJson.exports).filter((subpath) => (
            subpath.startsWith('./internal/')
        ))).toEqual([]);
        expect(Object.keys(packageJson.exports).filter((subpath) => (
            subpath.startsWith('./experimental/')
        ))).toEqual([]);
        expect(packageJson.exports['./internal/fs/json-owner-file-lock']).toBeUndefined();
        expect(packageJson.exports['./internal/fs/private-owner-file']).toBeUndefined();
        expect(packageJson.exports['./internal/managed-server-endpoint-projection']).toBeUndefined();
        expect(packageJson.exports['./internal/managed-server-endpoint-projection-resolver']).toBeUndefined();
        expect(packageJson.exports['./internal/settings-action-invoker']).toBeUndefined();
        expect(rootPublicApi).not.toHaveProperty('withExclusiveFileLock');
        expect(runtimePublicApi).not.toHaveProperty('withExclusiveFileLock');
        expect(rootPublicApi).not.toHaveProperty('PluginMachineMaterializationRefV1Schema');
        expectTypeOf<RootPluginMachineMaterializationRefV1>()
            .toEqualTypeOf<ProtocolPluginMachineMaterializationRefV1>();
        expect(rootPublicApi).not.toHaveProperty('PluginMachineExecutionOriginV1Schema');
        expectTypeOf<ActionsPluginMachineExecutionOriginV1>()
            .toEqualTypeOf<ProtocolPluginMachineExecutionOriginV1>();

        expect(packageJson.exports['./api']).toBeUndefined();
        expect(packageJson.exports['./experimental/agent-runtime-v1']).toBeUndefined();
        expect(packageJson.exports['./experimental/runtime/session']).toBeUndefined();
        expect(packageJson.exports['./experimental/acp']).toBeUndefined();
        expect(packageJson.exports['./experimental/legacy']).toBeUndefined();
        expect(packageJson.exports['./experimental/cloud/request-auth']).toBeUndefined();
        expect(() => createRequire(import.meta.url).resolve(
            '@happier-dev/plugin-sdk/experimental/cloud/request-auth',
        )).toThrow();
        expect(packageJson.exports['./experimental/cloud/broker']).toBeUndefined();
        expect(packageJson.exports['./experimental/runtime/limits']).toBeUndefined();
        expect(connectedAccountManifestApi).not.toHaveProperty('ConnectedAccountHostAdapterSchema');
        expect(connectedAccountManifestApi).not.toHaveProperty('resolveConnectedAccountHostAdapter');
        expect(connectedAccountManifestApi).not.toHaveProperty('ConnectedAccountDescriptorSchema');
        expect(connectedAccountManifestApi).not.toHaveProperty('BITBUCKET_CONNECTED_ACCOUNT_DESCRIPTOR');
        expect(connectedAccountManifestApi).not.toHaveProperty('getConnectedAccountDescriptor');
        expect(connectedAccountManifestApi).not.toHaveProperty('requireConnectedAccountDescriptor');
        expect(connectedAccountManifestApi)
            .toHaveProperty('PluginConnectedAccountConfigurationFieldV2Schema');
        expect(rootPublicApi)
            .not.toHaveProperty('PluginConnectedAccountConfigurationFieldV2Schema');
        expect(packageJson.exports['./experimental/testing/activation-v1']).toBeUndefined();
        expect(packageJson.exports['./experimental/testing/registration-scope']).toBeUndefined();
        expect(packageJson.exports['./experimental/sessions']).toBeUndefined();
        expect(packageJson.exports['./ui/hostApiClient']).toBeUndefined();
        for (const accidental of [
            './acp',
            './agent-runtime-v1',
            './distribution',
            './internal/runtime/executionRun',
            './internal/runtime/session',
            './legacy',
            './manifest/agentSettings',
            './experimental/manifest/agentSettings',
            './runtime/session',
            './ui/artifacts',
            './ui/artifactIntegrity',
            './ui/bridgeClient',
            './ui/hostRuntimeExternalsBuildPlugin',
            './ui/hostedWeb',
            './ui/hostedWebBuild',
            './ui/hostedWebDevServer',
            './ui/hostedWebRuntime',
            './ui/reactNativeBundles',
            './ui/reactNativeDevServer',
            './ui/reactNativeBuild',
            './ui/reactNativeWebBuild',
            './ui/reactNativeRepackStrictSafety',
            './account-usage',
            './usage',
        ]) {
            expect(packageJson.exports[accidental], accidental).toBeUndefined();
        }
    });

    it('keeps workflow-record authority private while resolving the two supported host-internal bridges', async () => {
        const packageJson = JSON.parse(
            await readFile(new URL('../package.json', import.meta.url), 'utf8'),
        ) as PluginSdkPackageJson;

        expect(
            packageJson.exports['./host/agent-runtime/workflow-run-record-port'],
        ).toBeUndefined();
        expect(() => createRequire(import.meta.url).resolve(
            '@happier-dev/plugin-sdk/host/agent-runtime/workflow-run-record-port',
        )).toThrow();
        expect(createRequire(import.meta.url).resolve(
            '@happier-dev/plugin-sdk/host/fs/json-owner-file-lock',
        )).toBe(
            fileURLToPath(new URL(
                '../dist/host/fs/json-owner-file-lock/index.js',
                import.meta.url,
            )),
        );
        expect(() => createRequire(import.meta.url).resolve(
            '@happier-dev/plugin-sdk/internal/fs/json-owner-file-lock',
        )).toThrow();
        expect(createRequire(import.meta.url).resolve(
            '@happier-dev/plugin-sdk/host/registration',
        )).toBe(
            fileURLToPath(new URL('../dist/host/registration/index.js', import.meta.url)),
        );
        expect(() => createRequire(import.meta.url).resolve(
            '@happier-dev/plugin-sdk/host/interactions',
        )).toThrow();
        expect(() => createRequire(import.meta.url).resolve(
            '@happier-dev/plugin-sdk/experimental/testing/registration-scope',
        )).toThrow();

        const registrationApi = await import('@happier-dev/plugin-sdk/host/registration');
        expect(Object.keys(registrationApi)).toEqual([
            'createExecutionRunHostBackendFromSessionRuntime',
            'createPluginActionHandlerNotStartedError',
            'createPluginRegistrationScope',
            'readPluginActionInputParser',
            'readPluginActionResultParser',
        ]);
        expectTypeOf<PackagePluginRuntimeRegistration>()
            .toEqualTypeOf<SourcePluginRuntimeRegistration>();
    });

    it('does not export the retired host-private single-shot execution runtime helper', async () => {
        const packageJson = JSON.parse(
            await readFile(new URL('../package.json', import.meta.url), 'utf8'),
        ) as PluginSdkPackageJson;

        expect(packageJson.exports['./experimental/executionRuns/singleShot']).toBeUndefined();
    });

    it('publishes one coherent Developer Preview policy with release-dispatch approval', async () => {
        const packageJson = JSON.parse(
            await readFile(new URL('../package.json', import.meta.url), 'utf8'),
        ) as PluginSdkPackageJson;
        const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

        expect(packageJson.version).toBe('0.0.0');
        expect(packageJson.private).toBe(true);
        expect(packageJson.dependencies.zod).toBe('4.3.6');
        expect(packageJson.devDependencies.zod).toBeUndefined();
        expect(packageJson.happier.publicSdkRelease).toMatchObject({
            posture: 'developer_preview',
            supportPolicy: 'README.md#public-sdk-release-posture',
            externalPublicationRequiresApproval: true,
        });
        expect(readme).toContain('## Public SDK release posture');
        expect(readme).toContain(
            'one package-level **Developer Preview** source contract',
        );
        expect(readme).toContain('Developer Preview is not a per-symbol stability tier.');
        // Developer Preview names the support contract without inventing a
        // frozen candidate or released-semver promise the source cannot honour.
        expect(readme).not.toContain('approved first public version');
        expect(readme).not.toContain('0.x minor');
    });

    inventoryIt('keeps root source and declared browser conditions aligned with the inventory', async () => {
        const inventory = requireApiSurfaceInventory(apiSurfaceInventoryRead);
        const packageJson = JSON.parse(
            await readFile(new URL('../package.json', import.meta.url), 'utf8'),
        ) as PluginSdkPackageJson;
        const rootEntrypoint = inventory.entrypoints.find(({ specifier }) => specifier === '.');
        if (!rootEntrypoint) throw new Error('API inventory is missing the package root');
        const rootSymbols = inventory.symbols.filter(({ specifier }) => specifier === '.');

        expect([...(await readNamedBarrelExports(rootEntrypoint.sourceModule))].sort())
            .toEqual(rootSymbols.map(({ exportName }) => exportName).sort());

        const browserTarget = rootEntrypoint.conditions.browser;
        expect(browserTarget).toBe('./dist/index.browser.js');
        expect(packageJson.exports['.']?.browser).toBe(browserTarget);

        const browserNames = await readNamedBarrelExports(
            sourceModuleForRuntimeCondition(browserTarget!),
        );
        const browserInventoryNames = rootSymbols
            .filter(({ realm }) => realm === 'any' || realm === 'browser' || realm === 'client')
            .map(({ exportName }) => exportName);
        expect([...browserNames].sort()).toEqual(browserInventoryNames.sort());

        expect(Object.keys(rootPublicApi).sort()).toEqual(rootSymbols
            .filter(({ kind }) => kind === 'value')
            .map(({ exportName }) => exportName)
            .sort());
    });

    inventoryIt('keeps External Sessions authoring on its final inventory-owned path', async () => {
        const contract = readAuthorSurfaceContract();
        const externalExports = await readNamedBarrelExports(
            contract.entrypoints['./sessions/external'],
        );
        const sessionExports = await readNamedBarrelExports(contract.entrypoints['./sessions']);

        expect([...externalExports].sort()).toEqual(
            [...contract.exports['./sessions/external']].sort(),
        );
        expect(sessionExports.filter((name) => externalExports.includes(name))).toEqual([]);
        expect(externalExports).toEqual(expect.arrayContaining([
            'AgentExternalSessionsContribution',
            'ExternalSessionRef',
            'ExternalSessionsService',
        ]));
    });

    inventoryIt('publishes only the two canonical External Session candidate-precedence values', () => {
        const candidateValues = readApiSurfaceInventory().symbols
            .filter((symbol) => (
                symbol.specifier === './sessions/external'
                && symbol.kind === 'value'
                && symbol.sourceModule === 'src/sessions/external.ts'
                && symbol.exportName.includes('ExternalSessionCandidate')
            ))
            .map((symbol) => ({
                exportName: symbol.exportName,
                sourceExport: symbol.sourceExport,
                realm: symbol.realm,
            }));

        expect(candidateValues).toEqual([
            {
                exportName: 'compareExternalSessionCandidatePrecedence',
                sourceExport: 'compareExternalSessionCandidatePrecedence',
                realm: 'daemon',
            },
            {
                exportName: 'resolveExternalSessionCandidateIdentityKey',
                sourceExport: 'resolveExternalSessionCandidateIdentityKey',
                realm: 'daemon',
            },
        ]);
    });

    inventoryIt('keeps file-follow path disclosure out of Sessions authoring', async () => {
        const exportedNames = await readNamedBarrelExports(
            readAuthorSurfaceContract().entrypoints['./sessions/external'],
        );

        expect(exportedNames).not.toContain(
            'AgentExternalSessionsResolveFollowTranscriptPathRequest',
        );
        expect(exportedNames).not.toContain(
            'AgentExternalSessionsResolveFollowTranscriptPathResult',
        );
    });

    inventoryIt('keeps connected-account transport and host custody off author surfaces', async () => {
        const connectedAccountExports = readAuthorSurfaceContract().exports['./connected-accounts'];

        for (const privateName of [
            'AgentConnectedServicesAdapter',
            'SessionConnectedServiceAuthApplyGenerationRequestV1',
            'SessionConnectedServiceAuthApplyGenerationResponseV1',
            'SessionConnectedServiceAuthReadRuntimeIdentityRequestV1',
            'SessionConnectedServiceAuthReadRuntimeIdentityResponseV1',
            'SessionMetadataConnectedServiceBinding',
            'getAgentConnectedServicesAdapter',
            'readSessionMetadataConnectedServiceBindings',
        ]) {
            expect(connectedAccountExports, privateName).not.toContain(privateName);
        }
    });

    it('keeps Connected Accounts runtime authorities out while retaining declaration supports', async () => {
        const exportedNames = await readNamedBarrelExports(
            'src/connected-accounts/index.public.ts',
        );

        expect(exportedNames).toEqual(expect.arrayContaining([
            'ConnectedAccountsService',
            'ConnectedAccountBindingSummary',
            'ConnectedAccountAuthDiagnostic',
            'ConnectedAccountAuthFailure',
            'ConnectedAccountMaterialization',
            'ConnectedAccountRuntime',
            'ConnectedAccountServiceKey',
            'ConnectedServiceCredentialRecordV1',
            'ConnectedServiceId',
            'PluginConnectedAccountDescriptorContributionV2',
            'QualifiedConnectedAccountRef',
            'QualifiedConnectedAccountRefSchema',
        ]));
        for (const privateName of [
            'AuthCredentialWriteInput',
            'AuthCredentialWriteResult',
            'AuthDiagnostic',
            'AuthenticateOptions',
            'AuthenticateResult',
            'Authenticator',
            'AuthenticatorContext',
            'ConnectedAccountAuthFailureRequestV1Schema',
            'ConnectedAccountQuotaFailureRequestV1Schema',
            'ConnectedAccountRequestAuthMaterialization',
            'ConnectedAccountRequestAuthUse',
            'ConnectedAccountRequestAuthUsesV1Schema',
            'ConnectedServiceAuthGroupId',
            'ConnectedServiceAuthGroupIdSchema',
            'ConnectedServiceBindings',
            'ConnectedServiceBindingsV1Schema',
            'ConnectedServiceCredentialRecordV1Schema',
            'ConnectedServiceCredentialRevisionV1',
            'ConnectedServiceCredentialRevisionV1Schema',
            'ConnectedServiceLimitCategoryV1',
            'ConnectedServiceProfileId',
            'ConnectedServiceProfileIdSchema',
            'ConnectedServiceQuotaMeterV1',
            'ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1',
            'ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1Schema',
            'ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1',
            'ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema',
            'ConnectedServiceQuotaRecoveryCreditKindV1',
            'ConnectedServiceQuotaRecoveryCreditKindV1Schema',
            'ConnectedServiceQuotaRecoveryCreditStatusV1',
            'ConnectedServiceQuotaRecoveryCreditStatusV1Schema',
            'ConnectedServiceQuotaRecoveryCreditV1',
            'ConnectedServiceQuotaRecoveryCreditV1Schema',
            'ConnectedServiceQuotaRecoveryCreditsV1',
            'ConnectedServiceQuotaRecoveryCreditsV1Schema',
            'ConnectedServiceQuotaSnapshotV1',
            'ConnectedServiceQuotaSnapshotV1Schema',
            'ConnectedServiceUsageSourceV1',
            'ConnectedServiceUsageSourceV1Schema',
            'ConnectedServicesProviderStateSharingPolicyV1',
            'ProviderAccountUsageQuotaScope',
            'QualifiedConnectedAccountGroupV4',
            'QualifiedConnectedAccountGroupV4Schema',
            'QualifiedConnectedAccountListResponseV4Schema',
            'QualifiedConnectedAccountPurpose',
            'QualifiedConnectedAccountPurposeBinding',
            'QualifiedConnectedAccountPurposeBindingTarget',
            'QualifiedConnectedAccountPurposeBindingV1Schema',
            'QualifiedConnectedAccountPurposeBindingsV1',
            'buildConnectedServiceCredentialRecord',
            'isAuthenticateResult',
            'normalizeConnectedServiceLimitCategoryV1',
            'resolveConnectedServicesProviderStateSharingPolicyV1',
        ]) {
            expect(exportedNames, privateName).not.toContain(privateName);
        }
    });

    inventoryIt('keeps retired rich-follow host contracts out of Sessions authoring', async () => {
        const exportedNames = await readNamedBarrelExports(
            readAuthorSurfaceContract().entrypoints['./sessions/external'],
        );

        expect(exportedNames).toEqual(expect.arrayContaining([
            'AgentExternalSessionObservationContribution',
            'AgentExternalSessionsContribution',
            'AgentExternalSessionsListCandidatesRequest',
        ]));
        for (const retired of [
            'ExternalSessionCandidateHostListRequestV1',
            'ExternalSessionCandidateHostRuntimeServiceV1',
            'ExternalSessionFileFollowInputV1',
            'ExternalSessionFileFollowRuntimeServiceV1',
            'ExternalSessionFollowLeaseV1',
            'ExternalSessionFollowTranscriptPathResolutionV1',
            'ExternalSessionProviderStoreKeyV1',
            'ExternalSessionResolveFollowTranscriptPathRequestV1',
            'ExternalSessionRuntimeContextV1',
            'ExternalSessionTranscriptStoreFollowRequestV1',
            'ExternalSessionTranscriptStorePageRequestV1',
            'ExternalSessionTranscriptStoreReadAfterRequestV1',
            'ExternalSessionTranscriptStoreRuntimeServiceV1',
            'ExternalSessionTakeoverInputV1',
            'ExternalSessionTakeoverResultV1',
        ]) {
            expect(exportedNames, retired).not.toContain(retired);
        }
    });

    inventoryIt('exports only the canonical takeover contracts from Sessions authoring', async () => {
        const exportedNames = await readNamedBarrelExports(
            readAuthorSurfaceContract().entrypoints['./sessions/external'],
        );

        expect(exportedNames.filter((name) => name.includes('Takeover')).sort()).toEqual([
            'AgentExternalSessionTakeoverContribution',
            'AgentExternalSessionTakeoverLaunchPlan',
            'AgentExternalSessionTakeoverResolveLaunchCallback',
            'AgentExternalSessionTakeoverResolveLaunchRequest',
            'AgentExternalSessionTakeoverResolveLaunchResult',
            'ExternalSessionTakeoverCapability',
            'ExternalSessionTakeoverIdempotencyKey',
            'ExternalSessionTakeoverRequest',
            'validateAgentExternalSessionTakeoverContribution',
            'validateAgentExternalSessionTakeoverLaunchPlan',
            'validateAgentExternalSessionTakeoverResolveLaunchRequest',
            'validateAgentExternalSessionTakeoverResolveLaunchResult',
        ]);
        expect(exportedNames).not.toContain('resolveTakeoverSpawnOptions');
        expect(exportedNames).not.toContain('SpawnSessionOptions');
        expect(exportedNames).not.toContain('BackendSessionLaunchHintsV1');
    });

    inventoryIt('exports the exact current observation authoring types from Sessions authoring', async () => {
        const observationTypes = (await readNamedBarrelExports(
            readAuthorSurfaceContract().entrypoints['./sessions/external'],
        )).filter((name) => name.includes('Observation'));

        expect(observationTypes.sort()).toEqual([
            'AgentExternalSessionObservationContribution',
            'AgentExternalSessionObservationDescribeResourceRequest',
            'AgentExternalSessionObservationLinkEvidenceBatchV1',
            'AgentExternalSessionObservationLinkKeyV1',
            'AgentExternalSessionObservationObserveResourceRequest',
            'AgentExternalSessionObservationReconcileLink',
            'AgentExternalSessionObservationReconcilePurposeV1',
            'AgentExternalSessionObservationReconcileRequestV1',
            'AgentExternalSessionObservationReconcileResourceRequest',
            'AgentExternalSessionObservationReconcileResultV1',
            'AgentExternalSessionObservationResourceDescriptorOutcomeV1',
            'AgentExternalSessionObservationResourceDescriptorV1',
            'AgentExternalSessionObservationResourceGroupingV1',
            'AgentExternalSessionObservationResourceKeyV1',
            'AgentExternalSessionObservationWatchFileChangesV1',
        ]);
        expect(observationTypes.some((name) => name.startsWith('ExternalAgentObservation')))
            .toBe(false);
    });

    inventoryIt('keeps canonical transient interactions in the generated author inventory', async () => {
        await expectCanonicalInventoryBarrelClosure('./interactions', [
            'InteractionTerminalStatusV1',
            'InteractionTransientApprovalAuthorRequestV1',
            'InteractionTransientApprovalResultV1',
            'InteractionTransientAuthorQuestionV1',
            'InteractionTransientAuthorRequestV1',
            'InteractionTransientChoiceSelectionV1',
            'InteractionTransientConfirmationAuthorRequestV1',
            'InteractionTransientConfirmationResultV1',
            'InteractionTransientQuestionAnswerV1',
            'InteractionTransientQuestionsAuthorRequestV1',
            'InteractionTransientQuestionsResultV1',
            'InteractionTransientResultV1',
        ], [
            'InteractionApprovalRequest',
            'InteractionApprovalResult',
            'InteractionChoiceAnswer',
            'InteractionQuestion',
            'InteractionQuestionAnswer',
            'InteractionQuestionChoice',
            'InteractionQuestionsResult',
        ]);
    });

    inventoryIt('keeps semantic UI fixture contracts in the generated testing inventory', async () => {
        await expectCanonicalInventoryBarrelClosure('./testing', [
            'PluginUiHostApiWireIdentityV1',
            'PluginUiSemanticAdapterNode',
            'PluginUiSemanticAdapterSnapshot',
            'PluginUiSemanticAdapterSnapshotSchema',
            'PluginUiSemanticAdapterText',
            'PluginUiSemanticQueryOptions',
            'PluginUiSemanticRole',
            'PluginUiSemanticRoleSchema',
            'PluginUiSemanticState',
            'PluginUiSemanticStateSchema',
            'PluginUiSemanticSurfaceAdapter',
            'PluginUiSemanticSurfaceMount',
            'PluginUiSemanticTarget',
            'PluginUiSemanticTargetSchema',
            'PluginUiSemanticTextTarget',
            'PluginUiSemanticTextTargetSchema',
            'PluginUiTestkit',
            'PluginUiTestkitExecuteActionInput',
            'PluginUiTestkitHostHandlers',
            'PluginUiTestkitMountAvailability',
            'PluginUiTestkitMountInput',
            'PluginUiTestkitMountOptions',
            'PluginUiTestkitMountResult',
            'PluginUiTestkitOpenConnectedAccountsInput',
            'PluginUiTestkitOpenSurfaceInput',
            'PluginUiTestkitSelectActionInputInput',
            'PluginUiTestkitSettleEphemeralInputInput',
            'PluginUiTestkitOptions',
            'PluginUiTestkitReadOpenableContentInput',
            'PluginUiTestkitReadResourceInput',
            'PluginUiTestkitStatOpenableContentInput',
            'PluginUiTestkitWatchResourceInput',
            'SURFACE_CONTEXT_THEME_FIXTURE',
            'createSurfaceContextFixture',
            'createPluginUiTestkit',
        ]);
    });

    inventoryIt('keeps UI content contracts in the generated UI inventory', async () => {
        await expectCanonicalInventoryBarrelClosure('./ui', [
            'OpenableContentBody',
            'OpenableContentReadRequest',
            'OpenableContentReadResult',
            'OpenableContentRef',
            'OpenableContentStatResult',
        ], [
            'PluginTargetedContributionSelectionV1',
        ]);
    });

    inventoryIt('keeps manifest and review signature dependencies in the generated author inventory', async () => {
        await expectCanonicalInventoryBarrelClosure('./manifest', [
            'AgentUiBehaviorDeclarationV1',
            'AgentUiConditionV1',
            'AgentUiComponentsDeclarationV1',
            'AgentUiExternalSessionsSourceV1',
            'AgentUiMessageDeclarationV1',
            'AgentUiRuntimeDescriptorAgentExtraIdentityV1',
            'AgentUiRuntimeDescriptorAgentExtraV1',
            'AgentUiRuntimeDescriptorLinkExtrasV1',
            'AgentUiTranscriptStorageModeV1',
            'PluginCollectionProjectedScalarFieldRefV1',
            'PluginCollectionRowCommandV1',
            'PluginAgentUiContribution',
            'PluginDeclarativeActionVariantV2',
            'PluginDeclarativeCollectionListNodeV2',
            'PluginDeclarativeMetadataEntryV2',
            'PluginDeclarativeRowNodeV2',
            'PluginDeclarativeStateV2',
            'PluginJsonSchemaValidator',
        ]);
        await expectCanonicalInventoryBarrelClosure('./reviews', [
            'ReviewCommentPublicationMarkerMatchV1',
            'ReviewCommentPublicationTargetExpectationV1',
            'ScmPullRequestReviewScopeProductionV1',
            'ScmPullRequestReviewScopeV1',
            'produceScmPullRequestReviewScope',
        ]);
    });

    it('gives each author contract one source-barrel owner before inventory generation', async () => {
        const rootExports = await readNamedBarrelExports('src/index.ts');
        const actionExports = await readNamedBarrelExports('src/actions/index.ts');
        const protocolBarrelExports = await readNamedBarrelExports('src/protocol/index.ts');
        const contributionsBarrelExports = await readNamedBarrelExports('src/contributions/index.ts');
        const uiExports = await readNamedBarrelExports('src/ui/index.ts');

        for (const duplicate of protocolExports) {
            expect(rootExports, duplicate).not.toContain(duplicate);
            expect(protocolBarrelExports, duplicate).toContain(duplicate);
        }
        for (const duplicate of contributionExports) {
            expect(rootExports, duplicate).not.toContain(duplicate);
            expect(contributionsBarrelExports, duplicate).toContain(duplicate);
        }
        for (const helper of protocolAuthoringSignatureHelperExports) {
            expect(contributionsBarrelExports, helper).toContain(helper);
        }
        expect(rootExports, 'PluginMachineExecutionOriginV1').not.toContain(
            'PluginMachineExecutionOriginV1',
        );
        expect(actionExports).toContain('PluginMachineExecutionOriginV1');
        expect(actionExports).toContain('PluginActionAuthorDefaults');
        expect(uiExports, 'PluginTargetedContributionSelectionV1').not.toContain(
            'PluginTargetedContributionSelectionV1',
        );
        expect(contributionsBarrelExports).toContain('PluginTargetedContributionSelectionV1');
    });

    inventoryIt('gives each author contract one semantic public owner', async () => {
        await expectCanonicalInventoryBarrelClosure('.', [], [
            ...protocolExports,
            ...contributionExports,
            'PluginMachineExecutionOriginV1',
        ]);
        await expectCanonicalInventoryBarrelClosure('./actions', [
            'ActionsService',
            'ContributedActionExecutionWithOriginResult',
            'PluginActionAuthorDefaults',
            'PluginMachineExecutionOriginV1',
        ]);
        await expectCanonicalInventoryBarrelClosure('./protocol', protocolExports);
        await expectCanonicalInventoryBarrelClosure('./contributions', [
            ...contributionExports,
            ...protocolAuthoringSignatureHelperExports,
        ]);
    });

    inventoryIt('keeps browser contribution authoring beside the public toolchain packet', async () => {
        await expectCanonicalInventoryBarrelClosure('./browser', [
            'PUBLIC_TOOLCHAIN_COMPATIBILITY_V1',
            'BrowserActionContribution',
            'BrowserActionContributionInput',
            'BrowserTargetContribution',
            'BrowserTargetContributionInput',
            'defineBrowserAction',
            'defineBrowserTarget',
        ]);
    });

    inventoryIt('keeps notifications public on host-mediated service outcomes until channel registration has a consumer', async () => {
        await expectCanonicalInventoryBarrelClosure('./notifications', [
            'NotificationBatchResult',
            'NotificationCategoryContribution',
            'NotificationCategorySummary',
            'NotificationChannelContribution',
            'NotificationChannelSummary',
            'NotificationPreferences',
            'NotificationSendRequest',
            'NotificationSendResult',
            'NotificationSender',
            'NotificationsService',
            'PluginNotificationRegistrationApi',
        ]);
    });

    it('keeps the normal testing path limited to daemon-independent testkits and bounded UI semantics', () => {
        expect(Object.keys(testingPublicApi).sort()).toEqual([
            'PluginUiSemanticAdapterSnapshotSchema',
            'PluginUiSemanticRoleSchema',
            'PluginUiSemanticStateSchema',
            'PluginUiSemanticTargetSchema',
            'PluginUiSemanticTextTargetSchema',
            'SURFACE_CONTEXT_THEME_FIXTURE',
            'createAgentSessionRuntimeHarness',
            'createPluginTestkit',
            'createPluginUiTestkit',
            'createSurfaceContextFixture',
            'readPluginUiTestkitTargetedSurfaceAdmission',
        ]);
    });
});
