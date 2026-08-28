import { fileURLToPath } from 'node:url';

import { build } from 'vite';
import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';

import {
    ProviderRefreshPolicySchema,
    ScmCapabilitiesSchema as ProtocolScmCapabilitiesSchema,
    SourceControlCloneProtocolSchema,
    createScmCapabilities as protocolCreateScmCapabilities,
    type ProviderRefreshPolicy,
    type ScmBackendCapabilities as ProtocolScmBackendCapabilities,
    type ScmBackendCapabilityLeaf as ProtocolScmBackendCapabilityLeaf,
    type ScmBackendCapabilityUnavailableReason as ProtocolScmBackendCapabilityUnavailableReason,
    type ScmBackendContribution as ProtocolScmBackendContribution,
    type ScmBackendDescribeRequest as ProtocolScmBackendDescribeRequest,
    type ScmBackendDescribeResponse as ProtocolScmBackendDescribeResponse,
    type ScmBackendId as ProtocolScmBackendId,
    type ScmCapabilities as ProtocolScmCapabilities,
    type ScmHostingProviderContribution as ProtocolScmHostingProviderContribution,
    type ScmHostingProviderKind as ProtocolScmHostingProviderKind,
    type ScmHostingProviderRef as ProtocolScmHostingProviderRef,
    type ScmHostingRepositoryAuthSummary as ProtocolScmHostingRepositoryAuthSummary,
    type ScmHostingRepositoryDescribePublishTargetsRequest as ProtocolScmHostingRepositoryDescribePublishTargetsRequest,
    type ScmHostingRepositoryDescribePublishTargetsResponse as ProtocolScmHostingRepositoryDescribePublishTargetsResponse,
    type ScmHostingRepositoryIdentityV1 as ProtocolScmHostingRepositoryIdentityV1,
    type ScmHostingRepositoryPublishRequest as ProtocolScmHostingRepositoryPublishRequest,
    type ScmHostingRepositoryPublishResponse as ProtocolScmHostingRepositoryPublishResponse,
    type ScmHostingRepositoryPublishTarget as ProtocolScmHostingRepositoryPublishTarget,
    type ScmHostingRepositoryRemoteUrlKind as ProtocolScmHostingRepositoryRemoteUrlKind,
    type ScmHostingRepositorySummary as ProtocolScmHostingRepositorySummary,
    type ScmHostingRepositoryVisibility as ProtocolScmHostingRepositoryVisibility,
    type ScmWorkingSnapshot as ProtocolScmWorkingSnapshot,
    type SourceControlCloneProtocol,
} from '@happier-dev/protocol';

import * as rootScm from './index.js';
import * as scmBackend from './backend/index.js';
import * as scmHosting from './hosting/index.js';
import * as scmProjection from './projections.js';
import type {
    ScmBackendCapabilities,
    ScmBackendCapabilityLeaf,
    ScmBackendCapabilityUnavailableReason,
    ScmBackendContribution,
    ScmBackendDescribeRequest,
    ScmBackendDescribeResponse,
    ScmBackendId,
} from './backend.js';
import type {
    HostingProviderContribution,
    ScmHostingProviderKind,
    ScmHostingProviderRef,
} from './hostingProvider.js';
import {
    ScmCapabilitiesSchema,
    ScmCloneProtocolSchema,
    ScmRefreshPolicySchema,
    createScmCapabilities,
    encodeCompareRef,
    evaluateScmRemoteMutationPreconditions,
    normalizeScmHostingRepositoryIdentity,
    parseScmRemoteUrl,
    sameScmHostingRepositoryIdentity,
    stripTrailingSlash,
    type ScmCapabilities,
    type ScmCloneProtocol,
    type ScmRefreshPolicy,
    type ScmRemoteMutationGuardResult,
    type ScmRemoteUrlScheme,
} from './projections.js';
import {
    encodeCompareRef as sourceEncodeCompareRef,
    parseScmRemoteUrl as sourceParseScmRemoteUrl,
    stripTrailingSlash as sourceStripTrailingSlash,
    type ScmRemoteUrlScheme as SourceScmRemoteUrlScheme,
} from './remoteUrl.js';
import {
    evaluateScmRemoteMutationPreconditions as sourceEvaluateScmRemoteMutationPreconditions,
    type ScmRemoteMutationGuardResult as SourceScmRemoteMutationGuardResult,
} from './remoteMutationPreconditions.js';
import * as backendProjection from './backendProjections.js';
import * as hostingProviderProjection from './hostingProviderProjections.js';
import * as protocolScm from '@happier-dev/protocol/scm';

const ROOT_RUNTIME_EXPORTS = [
    'SCM_COMMIT_MESSAGE_MAX_LENGTH',
    'SCM_COMMIT_PATCH_MAX_COUNT',
    'SCM_COMMIT_PATCH_MAX_LENGTH',
    'SCM_OPERATION_ERROR_CODES',
    'SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN',
    'ScmCapabilitiesSchema',
    'ScmCloneProtocolSchema',
    'ScmRefreshPolicySchema',
    'ScmSelectedMutationPathSchema',
    'ScmWorkingSnapshotSchema',
    'createScmCapabilities',
    'encodeCompareRef',
    'evaluateScmRemoteMutationPolicy',
    'evaluateScmRemoteMutationPreconditions',
    'isScmPatchBoundToPath',
    'normalizeScmBranchSourceRef',
    'normalizeScmHostingRepositoryIdentity',
    'normalizeScmRemoteName',
    'normalizeScmRemoteRequest',
    'normalizeScmRemoteUrl',
    'parseScmRemoteUrl',
    'resolveScmScopedChangedPaths',
    'sameScmHostingRepositoryIdentity',
    'stripTrailingSlash',
] as const;

const TRANSITIVE_DECLARATION_CLOSURE_TYPES = [
    'ScmBranchSourceRefNormalizationResult',
    'ScmRemoteMutationResult',
    'ScmRemoteMutationSnapshot',
    'ScmRemoteNameNormalizationResult',
    'ScmRemoteRequestNormalizationResult',
    'ScmRemoteUrlNormalizationResult',
] as const;

const ROOT_TYPE_EXPORTS = [
    'ParsedScmRemoteUrl',
    'PluginScmRegistrationApi',
    'ScmBranchCheckoutRequest',
    'ScmBranchCheckoutResponse',
    'ScmBranchCreateRequest',
    'ScmBranchCreateResponse',
    'ScmBranchIntegrationOperation',
    'ScmBranchIntegrationRequest',
    'ScmBranchIntegrationResponse',
    'ScmBranchListEntry',
    'ScmBranchListRequest',
    'ScmBranchListResponse',
    'ScmBranchOperationControlRequest',
    'ScmCapabilities',
    'ScmChangeApplyRequest',
    'ScmChangeApplyResponse',
    'ScmChangeDiscardRequest',
    'ScmChangeDiscardResponse',
    'ScmCloneProtocol',
    'ScmCommitBackoutRequest',
    'ScmCommitBackoutResponse',
    'ScmCommitCreateRequest',
    'ScmCommitCreateResponse',
    'ScmDefaultBranchPushPolicy',
    'ScmDiffCommitRequest',
    'ScmDiffCommitResponse',
    'ScmDiffFileRequest',
    'ScmDiffFileResponse',
    'ScmFollowupAction',
    'ScmHostingRepositoryAuthSummary',
    'ScmHostingRepositoryDescribePublishTargetsRequest',
    'ScmHostingRepositoryDescribePublishTargetsResponse',
    'ScmHostingRepositoryIdentityV1',
    'ScmHostingRepositoryPublishRequest',
    'ScmHostingRepositoryPublishResponse',
    'ScmHostingRepositoryPublishTarget',
    'ScmHostingRepositoryRemoteUrlKind',
    'ScmHostingRepositorySummary',
    'ScmHostingRepositoryVisibility',
    'ScmLogEntry',
    'ScmLogListRequest',
    'ScmLogListResponse',
    'ScmOperationErrorCode',
    'ScmOperationState',
    'ScmPullRequestAuthState',
    'ScmPullRequestCheckoutRequest',
    'ScmPullRequestCheckoutResponse',
    'ScmPullRequestChecksState',
    'ScmPullRequestGetRequest',
    'ScmPullRequestGetResponse',
    'ScmPullRequestListRequest',
    'ScmPullRequestListResponse',
    'ScmPullRequestOpenComposeRequest',
    'ScmPullRequestOpenComposeResponse',
    'ScmPullRequestOpenOrReuseRequest',
    'ScmPullRequestOpenOrReuseResponse',
    'ScmPullRequestPrepareWorktreeRequest',
    'ScmPullRequestPrepareWorktreeResponse',
    'ScmPullRequestReference',
    'ScmPullRequestRunStackedPhase',
    'ScmPullRequestRunStackedProgressEvent',
    'ScmPullRequestRunStackedRequest',
    'ScmPullRequestRunStackedResponse',
    'ScmPullRequestState',
    'ScmPullRequestStatusProjection',
    'ScmPullRequestSummary',
    'ScmRefreshPolicy',
    'ScmRemoteAddRequest',
    'ScmRemoteInfo',
    'ScmRemoteManagementResponse',
    'ScmRemoteMutationGuardResult',
    'ScmRemoteMutationKind',
    'ScmRemoteMutationPolicy',
    'ScmRemoteMutationReason',
    'ScmRemoteMutationReasonMapper',
    'ScmRemotePublishRequest',
    'ScmRemotePublishResponse',
    'ScmRemoteRemoveRequest',
    'ScmRemoteRequest',
    'ScmRemoteResponse',
    'ScmRemoteSetUrlRequest',
    'ScmRemoteUrlScheme',
    'ScmRepoMode',
    'ScmRepositoryCloneInput',
    'ScmRepositoryCloneOutput',
    'ScmRepositoryCloneTarget',
    'ScmRepositoryCloneTargetDescription',
    'ScmRepositoryInitRequest',
    'ScmRepositoryInitResponse',
    'ScmRepositoryRemoveIndexLockRequest',
    'ScmRepositoryRemoveIndexLockResponse',
    'ScmReviewWorkspaceCurrentness',
    'ScmReviewWorkspaceSourceTip',
    'ScmSelectedMutationPath',
    'ScmStashApplyRequest',
    'ScmStashApplyResponse',
    'ScmStashDropRequest',
    'ScmStashDropResponse',
    'ScmStashEntry',
    'ScmStashListRequest',
    'ScmStashListResponse',
    'ScmStashPopRequest',
    'ScmStashPopResponse',
    'ScmStashShowRequest',
    'ScmStashShowResponse',
    'ScmStatusSnapshotRequest',
    'ScmStatusSnapshotResponse',
    'ScmWorkingEntry',
    'ScmWorkingSnapshot',
    'ScmWorktree',
    'ScmWorktreeCreateRequest',
    'ScmWorktreeCreateResponse',
    'ScmWorktreeEnrichmentEntry',
    'ScmWorktreePruneRequest',
    'ScmWorktreePruneResponse',
    'ScmWorktreeRemoveRequest',
    'ScmWorktreeRemoveResponse',
    'ScmWorktreesEnrichmentRequest',
    'ScmWorktreesEnrichmentResponse',
    ...TRANSITIVE_DECLARATION_CLOSURE_TYPES,
] as const;

const ROOT_EXPORTS = [...ROOT_RUNTIME_EXPORTS, ...ROOT_TYPE_EXPORTS].sort();

const PORTABLE_VALUE_PROJECTIONS = [
    {
        source: './projections.ts',
        exports: ROOT_RUNTIME_EXPORTS,
    },
    {
        source: './backendProjections.ts',
        exports: [
            'ScmBackendCapabilitiesSchema',
            'ScmBackendContributionSchema',
            'createScmCapabilitiesFromBackendCapabilities',
            'mapGitScmErrorCode',
            'mapSaplingScmErrorCode',
            'supportedCapability',
            'unsupportedCapability',
        ],
    },
    {
        source: './hostingProviderProjections.ts',
        exports: [
            'ScmHostingProviderKindSchema',
            'resolveScmHostingProviderFollowupAllowedBaseUrl',
        ],
    },
] as const;

async function bundlePortableValues(input: (typeof PORTABLE_VALUE_PROJECTIONS)[number]): Promise<readonly string[]> {
    const source = fileURLToPath(new URL(input.source, import.meta.url));
    const protocolScmSource = fileURLToPath(
        new URL('../../../protocol/src/scm/index.ts', import.meta.url),
    );
    const moduleIds = new Set<string>();
    await build({
        configFile: false,
        logLevel: 'silent',
        plugins: [{
            name: 'scm-portable-value-projection',
            enforce: 'pre',
            resolveId(id) {
                if (id === '@happier-dev/protocol/scm') return protocolScmSource;
                return id === 'virtual:scm-portable-value-projection' ? `\0${id}` : null;
            },
            load(id) {
                if (id !== '\0virtual:scm-portable-value-projection') return null;
                return `export { ${input.exports.join(', ')} } from ${JSON.stringify(source)};`;
            },
            generateBundle() {
                for (const id of this.getModuleIds()) moduleIds.add(id);
            },
        }],
        build: {
            minify: false,
            target: 'es2022',
            write: false,
            rollupOptions: {
                input: 'virtual:scm-portable-value-projection',
                preserveEntrySignatures: 'strict',
                output: {
                    format: 'es',
                    inlineDynamicImports: true,
                },
            },
        },
    });
    return [...moduleIds].filter((id) => (
        id.startsWith('node:') || id.includes('__vite-browser-external')
    ));
}

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

function moduleTypeReexports(
    relativePath: string,
    moduleSpecifier: string,
): readonly Readonly<{ exportName: string; sourceName: string }>[] {
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    const fileName = `${packageRoot}/${relativePath}`;
    const sourceText = ts.sys.readFile(fileName);
    if (!sourceText) throw new Error(`Missing source module: ${relativePath}`);
    const sourceFile = ts.createSourceFile(
        fileName,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );

    return sourceFile.statements.flatMap((statement) => {
        if (
            !ts.isExportDeclaration(statement)
            || !statement.isTypeOnly
            || !statement.moduleSpecifier
            || !ts.isStringLiteral(statement.moduleSpecifier)
            || statement.moduleSpecifier.text !== moduleSpecifier
            || !statement.exportClause
            || !ts.isNamedExports(statement.exportClause)
        ) {
            return [];
        }
        return statement.exportClause.elements.map((element) => ({
            exportName: element.name.text,
            sourceName: (element.propertyName ?? element.name).text,
        }));
    });
}

type RootProjectionTypes = [
    scmProjection.ParsedScmRemoteUrl,
    scmProjection.PluginScmRegistrationApi,
    scmProjection.ScmBranchCheckoutRequest,
    scmProjection.ScmBranchCheckoutResponse,
    scmProjection.ScmBranchCreateRequest,
    scmProjection.ScmBranchCreateResponse,
    scmProjection.ScmBranchIntegrationOperation,
    scmProjection.ScmBranchIntegrationRequest,
    scmProjection.ScmBranchIntegrationResponse,
    scmProjection.ScmBranchListEntry,
    scmProjection.ScmBranchListRequest,
    scmProjection.ScmBranchListResponse,
    scmProjection.ScmBranchOperationControlRequest,
    scmProjection.ScmBranchSourceRefNormalizationResult,
    scmProjection.ScmCapabilities,
    scmProjection.ScmChangeApplyRequest,
    scmProjection.ScmChangeApplyResponse,
    scmProjection.ScmChangeDiscardRequest,
    scmProjection.ScmChangeDiscardResponse,
    scmProjection.ScmCloneProtocol,
    scmProjection.ScmCommitBackoutRequest,
    scmProjection.ScmCommitBackoutResponse,
    scmProjection.ScmCommitCreateRequest,
    scmProjection.ScmCommitCreateResponse,
    scmProjection.ScmDefaultBranchPushPolicy,
    scmProjection.ScmDiffCommitRequest,
    scmProjection.ScmDiffCommitResponse,
    scmProjection.ScmDiffFileRequest,
    scmProjection.ScmDiffFileResponse,
    scmProjection.ScmFollowupAction,
    scmProjection.ScmHostingRepositoryAuthSummary,
    scmProjection.ScmHostingRepositoryDescribePublishTargetsRequest,
    scmProjection.ScmHostingRepositoryDescribePublishTargetsResponse,
    scmProjection.ScmHostingRepositoryIdentityV1,
    scmProjection.ScmHostingRepositoryPublishRequest,
    scmProjection.ScmHostingRepositoryPublishResponse,
    scmProjection.ScmHostingRepositoryPublishTarget,
    scmProjection.ScmHostingRepositoryRemoteUrlKind,
    scmProjection.ScmHostingRepositorySummary,
    scmProjection.ScmHostingRepositoryVisibility,
    scmProjection.ScmLogEntry,
    scmProjection.ScmLogListRequest,
    scmProjection.ScmLogListResponse,
    scmProjection.ScmOperationErrorCode,
    scmProjection.ScmOperationState,
    scmProjection.ScmPullRequestAuthState,
    scmProjection.ScmPullRequestCheckoutRequest,
    scmProjection.ScmPullRequestCheckoutResponse,
    scmProjection.ScmPullRequestChecksState,
    scmProjection.ScmPullRequestGetRequest,
    scmProjection.ScmPullRequestGetResponse,
    scmProjection.ScmPullRequestListRequest,
    scmProjection.ScmPullRequestListResponse,
    scmProjection.ScmPullRequestOpenComposeRequest,
    scmProjection.ScmPullRequestOpenComposeResponse,
    scmProjection.ScmPullRequestOpenOrReuseRequest,
    scmProjection.ScmPullRequestOpenOrReuseResponse,
    scmProjection.ScmPullRequestPrepareWorktreeRequest,
    scmProjection.ScmPullRequestPrepareWorktreeResponse,
    scmProjection.ScmPullRequestReference,
    scmProjection.ScmPullRequestRunStackedPhase,
    scmProjection.ScmPullRequestRunStackedProgressEvent,
    scmProjection.ScmPullRequestRunStackedRequest,
    scmProjection.ScmPullRequestRunStackedResponse,
    scmProjection.ScmPullRequestState,
    scmProjection.ScmPullRequestStatusProjection,
    scmProjection.ScmPullRequestSummary,
    scmProjection.ScmRefreshPolicy,
    scmProjection.ScmRemoteAddRequest,
    scmProjection.ScmRemoteInfo,
    scmProjection.ScmRemoteManagementResponse,
    scmProjection.ScmRemoteMutationGuardResult,
    scmProjection.ScmRemoteMutationKind,
    scmProjection.ScmRemoteMutationPolicy,
    scmProjection.ScmRemoteMutationReason,
    scmProjection.ScmRemoteMutationReasonMapper,
    scmProjection.ScmRemoteMutationResult,
    scmProjection.ScmRemoteMutationSnapshot,
    scmProjection.ScmRemoteNameNormalizationResult,
    scmProjection.ScmRemotePublishRequest,
    scmProjection.ScmRemotePublishResponse,
    scmProjection.ScmRemoteRemoveRequest,
    scmProjection.ScmRemoteRequest,
    scmProjection.ScmRemoteRequestNormalizationResult,
    scmProjection.ScmRemoteResponse,
    scmProjection.ScmRemoteSetUrlRequest,
    scmProjection.ScmRemoteUrlNormalizationResult,
    scmProjection.ScmRemoteUrlScheme,
    scmProjection.ScmRepoMode,
    scmProjection.ScmRepositoryCloneInput,
    scmProjection.ScmRepositoryCloneOutput,
    scmProjection.ScmRepositoryCloneTarget,
    scmProjection.ScmRepositoryCloneTargetDescription,
    scmProjection.ScmRepositoryInitRequest,
    scmProjection.ScmRepositoryInitResponse,
    scmProjection.ScmRepositoryRemoveIndexLockRequest,
    scmProjection.ScmRepositoryRemoveIndexLockResponse,
    scmProjection.ScmSelectedMutationPath,
    scmProjection.ScmStashApplyRequest,
    scmProjection.ScmStashApplyResponse,
    scmProjection.ScmStashDropRequest,
    scmProjection.ScmStashDropResponse,
    scmProjection.ScmStashEntry,
    scmProjection.ScmStashListRequest,
    scmProjection.ScmStashListResponse,
    scmProjection.ScmStashPopRequest,
    scmProjection.ScmStashPopResponse,
    scmProjection.ScmStashShowRequest,
    scmProjection.ScmStashShowResponse,
    scmProjection.ScmStatusSnapshotRequest,
    scmProjection.ScmStatusSnapshotResponse,
    scmProjection.ScmWorkingEntry,
    scmProjection.ScmWorkingSnapshot,
    scmProjection.ScmWorktree,
    scmProjection.ScmWorktreeCreateRequest,
    scmProjection.ScmWorktreeCreateResponse,
    scmProjection.ScmWorktreeEnrichmentEntry,
    scmProjection.ScmWorktreePruneRequest,
    scmProjection.ScmWorktreePruneResponse,
    scmProjection.ScmWorktreeRemoveRequest,
    scmProjection.ScmWorktreeRemoveResponse,
    scmProjection.ScmWorktreesEnrichmentRequest,
    scmProjection.ScmWorktreesEnrichmentResponse,
];

function assertRootProjectionExcludesMovedContracts(): void {
/* @sdk-negative-type-case:src-scm-projections-test-ts-38:Q29ubmVjdGVkLWFjY291bnQgY3JlZGVudGlhbHMgYmVsb25nIHRvIGAvY29ubmVjdGVkLWFjY291bnRzYC4:dHlwZSBDb25uZWN0ZWRBY2NvdW50Q3JlZGVudGlhbCA9IGltcG9ydCgnLi9wcm9qZWN0aW9ucy5qcycpLkNvbm5lY3RlZFNlcnZpY2VDcmVkZW50aWFsUmVjb3JkVjE7 */
type ConnectedAccountCredential = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-scm-projections-test-ts-39:QmFja2VuZCBjb250cmlidXRpb25zIGJlbG9uZyB0byBgL3NjbS9iYWNrZW5kYC4:dHlwZSBCYWNrZW5kQ29udHJpYnV0aW9uID0gaW1wb3J0KCcuL3Byb2plY3Rpb25zLmpzJykuU2NtQmFja2VuZENvbnRyaWJ1dGlvbjs */
type BackendContribution = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-scm-projections-test-ts-40:SG9zdGluZy1wcm92aWRlciBpZGVudGl0aWVzIGJlbG9uZyB0byBgL3NjbS9ob3N0aW5nYC4:dHlwZSBIb3N0aW5nUHJvdmlkZXIgPSBpbXBvcnQoJy4vcHJvamVjdGlvbnMuanMnKS5TY21Ib3N0aW5nUHJvdmlkZXJSZWY7 */
type HostingProvider = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-scm-projections-test-ts-41:VGhlIHVucHJlZml4ZWQgcHJlZGVjZXNzb3IgbmFtZSBpcyByZXBsYWNlZCBvbiB0aGUgZmluYWwgc3VyZmFjZS4:dHlwZSBMZWdhY3lSZWZyZXNoUG9saWN5ID0gaW1wb3J0KCcuL3Byb2plY3Rpb25zLmpzJykuUHJvdmlkZXJSZWZyZXNoUG9saWN5Ow */
type LegacyRefreshPolicy = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-scm-projections-test-ts-42:VGhlIHVucHJlZml4ZWQgcHJlZGVjZXNzb3IgbmFtZSBpcyByZXBsYWNlZCBvbiB0aGUgZmluYWwgc3VyZmFjZS4:dHlwZSBMZWdhY3lDbG9uZVByb3RvY29sID0gaW1wb3J0KCcuL3Byb2plY3Rpb25zLmpzJykuU291cmNlQ29udHJvbENsb25lUHJvdG9jb2w7 */
type LegacyCloneProtocol = never; /* @sdk-negative-type-case-end */
    void (null as unknown as ConnectedAccountCredential);
    void (null as unknown as BackendContribution);
    void (null as unknown as HostingProvider);
    void (null as unknown as LegacyRefreshPolicy);
    void (null as unknown as LegacyCloneProtocol);
}

describe('SCM package-local projections', () => {
    it.each(PORTABLE_VALUE_PROJECTIONS)(
        'keeps the $source publication values free of Node runtime reach',
        async (projection) => {
            expect(await bundlePortableValues(projection)).toEqual([]);
        },
        60_000,
    );

    it('exposes exactly the approved root runtime identities', () => {
        expect(Object.keys(scmProjection).sort()).toEqual(ROOT_RUNTIME_EXPORTS);
        for (const exportName of ROOT_RUNTIME_EXPORTS) {
            expect(rootScm[exportName]).toBe(scmProjection[exportName]);
        }
    });

    it('exposes exactly the approved source surface', () => {
        const program = createSdkProgram();
        expect(moduleExportNames(program, 'src/scm/projections.ts')).toEqual(ROOT_EXPORTS);
        expect(moduleExportNames(program, 'src/scm/index.ts')).toEqual(ROOT_EXPORTS);
    }, 120_000);

    it('preserves representative canonical runtime identities without wrappers', () => {
        expect(createScmCapabilities).toBe(protocolCreateScmCapabilities);
        expect(ScmCapabilitiesSchema).toBe(ProtocolScmCapabilitiesSchema);
        expect(ScmRefreshPolicySchema).toBe(ProviderRefreshPolicySchema);
        expect(ScmCloneProtocolSchema).toBe(SourceControlCloneProtocolSchema);
        expect(encodeCompareRef).toBe(sourceEncodeCompareRef);
        expect(parseScmRemoteUrl).toBe(sourceParseScmRemoteUrl);
        expect(stripTrailingSlash).toBe(sourceStripTrailingSlash);
        expect(evaluateScmRemoteMutationPreconditions)
            .toBe(sourceEvaluateScmRemoteMutationPreconditions);
        expect(normalizeScmHostingRepositoryIdentity)
            .toBe(protocolScm.normalizeScmHostingRepositoryIdentity);
        expect(sameScmHostingRepositoryIdentity)
            .toBe(protocolScm.sameScmHostingRepositoryIdentity);
        for (const exportName of PORTABLE_VALUE_PROJECTIONS[1].exports) {
            expect(backendProjection[exportName]).toBe(protocolScm[exportName]);
            expect(scmBackend[exportName]).toBe(backendProjection[exportName]);
        }
        for (const exportName of PORTABLE_VALUE_PROJECTIONS[2].exports) {
            expect(hostingProviderProjection[exportName]).toBe(protocolScm[exportName]);
            expect(scmHosting[exportName]).toBe(hostingProviderProjection[exportName]);
        }
    });

    it('owns the transitive declaration closure at the SDK boundary', () => {
        const closureTypes = new Set<string>(TRANSITIVE_DECLARATION_CLOSURE_TYPES);
        const closureReexports = moduleTypeReexports(
            'src/scm/projections.ts',
            '@happier-dev/protocol/scm',
        ).filter(({ exportName }) => closureTypes.has(exportName));

        expect(closureReexports).toEqual([]);
    });

    it('keeps all approved types nameable and preserves representative identities', () => {
        expectTypeOf<RootProjectionTypes>().toMatchTypeOf<readonly unknown[]>();
        expectTypeOf<ScmCapabilities>().toEqualTypeOf<ProtocolScmCapabilities>();
        expectTypeOf<typeof scmProjection.SCM_OPERATION_ERROR_CODES>()
            .toEqualTypeOf<typeof protocolScm.SCM_OPERATION_ERROR_CODES>();
        expectTypeOf<scmProjection.ScmWorkingSnapshot>()
            .toEqualTypeOf<ProtocolScmWorkingSnapshot>();
        expectTypeOf<NonNullable<scmProjection.ScmWorkingSnapshot['freshness']>['source']>()
            .toEqualTypeOf<'live-local' | 'cached-local' | 'cached-remote' | 'explicit-remote'>();
        expectTypeOf<NonNullable<scmProjection.ScmWorkingSnapshot['freshness']>['source']>()
            .toEqualTypeOf<NonNullable<ProtocolScmWorkingSnapshot['freshness']>['source']>();
        expectTypeOf<NonNullable<scmProjection.ScmPullRequestStatusProjection['freshness']>['source']>()
            .toEqualTypeOf<'live-local' | 'cached-local' | 'cached-remote' | 'explicit-remote'>();
        expectTypeOf<scmProjection.ScmHostingRepositoryAuthSummary>()
            .toEqualTypeOf<ProtocolScmHostingRepositoryAuthSummary>();
        expectTypeOf<scmProjection.ScmHostingRepositoryDescribePublishTargetsRequest>()
            .toEqualTypeOf<ProtocolScmHostingRepositoryDescribePublishTargetsRequest>();
        expectTypeOf<scmProjection.ScmHostingRepositoryDescribePublishTargetsResponse>()
            .toEqualTypeOf<ProtocolScmHostingRepositoryDescribePublishTargetsResponse>();
        expectTypeOf<scmProjection.ScmHostingRepositoryIdentityV1>()
            .toEqualTypeOf<ProtocolScmHostingRepositoryIdentityV1>();
        const githubIdentity = normalizeScmHostingRepositoryIdentity({
            kind: 'github',
            deployment: 'https://github.com',
            repository: 'Acme/App',
        });
        const broadIdentityInput: Readonly<{
            kind?: unknown;
            deployment?: unknown;
            repository?: unknown;
        }> = {
            kind: 'github',
            deployment: 'https://github.com',
            repository: 'Acme/App',
        };
        const broadIdentity = normalizeScmHostingRepositoryIdentity(broadIdentityInput);
        expectTypeOf(githubIdentity)
            .toEqualTypeOf<scmProjection.ScmHostingRepositoryIdentityV1<'github'> | null>();
        expectTypeOf(broadIdentity)
            .toEqualTypeOf<scmProjection.ScmHostingRepositoryIdentityV1 | null>();
        expectTypeOf<scmProjection.ScmHostingRepositoryPublishRequest>()
            .toEqualTypeOf<ProtocolScmHostingRepositoryPublishRequest>();
        expectTypeOf<scmProjection.ScmHostingRepositoryPublishResponse>()
            .toEqualTypeOf<ProtocolScmHostingRepositoryPublishResponse>();
        expectTypeOf<scmProjection.ScmHostingRepositoryPublishTarget>()
            .toEqualTypeOf<ProtocolScmHostingRepositoryPublishTarget>();
        expectTypeOf<scmProjection.ScmHostingRepositoryRemoteUrlKind>()
            .toEqualTypeOf<ProtocolScmHostingRepositoryRemoteUrlKind>();
        expectTypeOf<scmProjection.ScmHostingRepositorySummary>()
            .toEqualTypeOf<ProtocolScmHostingRepositorySummary>();
        expectTypeOf<scmProjection.ScmHostingRepositoryVisibility>()
            .toEqualTypeOf<ProtocolScmHostingRepositoryVisibility>();
        expectTypeOf<ScmRefreshPolicy>().toEqualTypeOf<ProviderRefreshPolicy>();
        expectTypeOf<ScmCloneProtocol>().toEqualTypeOf<SourceControlCloneProtocol>();
        expectTypeOf<ScmRemoteUrlScheme>().toEqualTypeOf<SourceScmRemoteUrlScheme>();
        expectTypeOf<ScmRemoteMutationGuardResult>()
            .toEqualTypeOf<SourceScmRemoteMutationGuardResult>();
        expectTypeOf<scmProjection.ScmBranchSourceRefNormalizationResult>()
            .toEqualTypeOf<protocolScm.ScmBranchSourceRefNormalizationResult>();
        expectTypeOf<scmProjection.ScmRemoteMutationResult>()
            .toEqualTypeOf<protocolScm.ScmRemoteMutationResult>();
        expectTypeOf<scmProjection.ScmRemoteMutationSnapshot>()
            .toEqualTypeOf<protocolScm.ScmRemoteMutationSnapshot>();
        expectTypeOf<scmProjection.ScmRemoteNameNormalizationResult>()
            .toEqualTypeOf<protocolScm.ScmRemoteNameNormalizationResult>();
        expectTypeOf<scmProjection.ScmRemoteRequestNormalizationResult>()
            .toEqualTypeOf<protocolScm.ScmRemoteRequestNormalizationResult>();
        expectTypeOf<scmProjection.ScmRemoteUrlNormalizationResult>()
            .toEqualTypeOf<protocolScm.ScmRemoteUrlNormalizationResult>();
        assertRootProjectionExcludesMovedContracts();
    });

    it('preserves backend and hosting author inference through their SDK subpaths', () => {
        expectTypeOf<ScmBackendCapabilities>()
            .toEqualTypeOf<ProtocolScmBackendCapabilities>();
        expectTypeOf<ScmBackendCapabilityLeaf>()
            .toEqualTypeOf<ProtocolScmBackendCapabilityLeaf>();
        expectTypeOf<ScmBackendCapabilityUnavailableReason>()
            .toEqualTypeOf<ProtocolScmBackendCapabilityUnavailableReason>();
        expectTypeOf<ScmBackendContribution>()
            .toEqualTypeOf<ProtocolScmBackendContribution>();
        expectTypeOf<ScmBackendDescribeRequest>()
            .toEqualTypeOf<ProtocolScmBackendDescribeRequest>();
        expectTypeOf<ScmBackendDescribeResponse>()
            .toEqualTypeOf<ProtocolScmBackendDescribeResponse>();
        expectTypeOf<ScmBackendId>()
            .toEqualTypeOf<ProtocolScmBackendId>();
        expectTypeOf<HostingProviderContribution>()
            .toMatchTypeOf<ProtocolScmHostingProviderContribution>();
        expectTypeOf<ProtocolScmHostingProviderContribution>()
            .toMatchTypeOf<HostingProviderContribution>();
        expectTypeOf<ScmHostingProviderKind>()
            .toEqualTypeOf<ProtocolScmHostingProviderKind>();
        expectTypeOf<ScmHostingProviderRef>()
            .toEqualTypeOf<ProtocolScmHostingProviderRef>();
    });
});
