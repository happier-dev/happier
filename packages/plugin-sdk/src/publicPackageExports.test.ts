import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import * as rootPublicApi from './index.js';
import * as connectedAccountManifestApi from './manifest/connectedAccountDescriptors.js';
import {
    NORMAL_ENTRYPOINTS,
    NORMAL_SURFACE_ALLOWLIST,
} from './normalSurfaceContract.js';
import * as runtimePublicApi from './runtime/index.js';
import * as testingPublicApi from './testing/index.js';

type PackageExportTarget = Readonly<{ types: string; default: string }>;
type PluginSdkPackageJson = Readonly<{
    version: string;
    private: boolean;
    exports: Readonly<Record<string, PackageExportTarget>>;
    happier: Readonly<{
        publicSdkRelease: Readonly<{
            posture: string;
            supportPolicy: string;
            externalPublicationRequiresApproval: boolean;
        }>;
    }>;
}>;

describe('CORE-A curated package exports', () => {
    it('routes stable public contracts through their canonical entrypoints', async () => {
        const packageJson = JSON.parse(
            await readFile(new URL('../package.json', import.meta.url), 'utf8'),
        ) as PluginSdkPackageJson;

        expect(Object.keys(packageJson.exports).filter((subpath) => (
            !subpath.startsWith('./experimental/')
            && !subpath.startsWith('./internal/')
        )).sort()).toEqual(Object.keys(NORMAL_ENTRYPOINTS).sort());
        expect(Object.keys(packageJson.exports).filter((subpath) => (
            subpath.startsWith('./internal/')
        )).sort()).toEqual([
            './internal/fs/json-owner-file-lock',
        ]);
        expect(packageJson.exports['./internal/fs/json-owner-file-lock']).toEqual({
            types: './dist/internal/fs/jsonOwnerFileLock.d.ts',
            default: './dist/internal/fs/jsonOwnerFileLock.js',
        });
        expect(rootPublicApi).not.toHaveProperty('withExclusiveFileLock');
        expect(runtimePublicApi).not.toHaveProperty('withExclusiveFileLock');

        expect(packageJson.exports['./api']).toBeUndefined();
        expect(packageJson.exports['./runtime']).toEqual({
            types: './dist/runtime/index.d.ts',
            default: './dist/runtime/index.js',
        });
        expect(packageJson.exports['./agent-runtime']).toEqual({
            types: './dist/agent-runtime.d.ts',
            default: './dist/agent-runtime.js',
        });
        expect(packageJson.exports['./experimental/providers']).toEqual({
            types: './dist/providers.d.ts',
            default: './dist/providers.js',
        });
        expect(packageJson.exports['./experimental/agent-runtime-v1']).toBeUndefined();
        expect(packageJson.exports['./experimental/agent-runtime/realtime']).toEqual({
            types: './dist/experimental/agentRuntime/realtime.d.ts',
            default: './dist/experimental/agentRuntime/realtime.js',
        });
        expect(packageJson.exports['./experimental/runtime/session']).toBeUndefined();
        expect(packageJson.exports['./experimental/acp']).toBeUndefined();
        expect(packageJson.exports['./experimental/legacy']).toBeUndefined();
        expect(packageJson.exports['./experimental/cloud/request-auth']).toEqual({
            types: './dist/cloud/requestAuth/index.d.ts',
            default: './dist/cloud/requestAuth/index.js',
        });
        expect(packageJson.exports['./experimental/cloud/broker']).toBeUndefined();
        expect(packageJson.exports['./experimental/runtime/limits']).toBeUndefined();
        expect(packageJson.exports['./experimental/manifest/connectedAccountDescriptors']).toEqual({
            types: './dist/manifest/connectedAccountDescriptors.d.ts',
            default: './dist/manifest/connectedAccountDescriptors.js',
        });
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
        expect(packageJson.exports['./experimental/manifest/agents']).toEqual({
            types: './dist/manifest/agents.d.ts',
            default: './dist/manifest/agents.js',
        });
        expect(packageJson.exports['./experimental/manifest/voiceModelPacks']).toEqual({
            types: './dist/manifest/voiceModelPacks.d.ts',
            default: './dist/manifest/voiceModelPacks.js',
        });
        expect(packageJson.exports['./experimental/ui/hosted-web-bridge-v1']).toEqual({
            types: './dist/experimental/uiHostedWebBridgeV1.d.ts',
            default: './dist/experimental/uiHostedWebBridgeV1.js',
        });
        expect(packageJson.exports['./experimental/testing/activation-v1']).toBeUndefined();
        expect(packageJson.exports['./experimental/testing/registration-scope']).toEqual({
            types: './dist/experimental/testingRegistrationScope.d.ts',
            default: './dist/experimental/testingRegistrationScope.js',
        });
        expect(packageJson.exports['./testing']).toEqual({
            types: './dist/testing/index.d.ts',
            default: './dist/testing/index.js',
        });
        expect(packageJson.exports['./ui']).toEqual({
            types: './dist/ui.d.ts',
            default: './dist/ui.js',
        });
        expect(packageJson.exports['./ui/build']).toEqual({
            types: './dist/ui/build/index.d.ts',
            default: './dist/ui/build/index.js',
        });
        expect(packageJson.exports['./ui/client']).toEqual({
            types: './dist/ui/client.d.ts',
            default: './dist/ui/client.js',
        });
        expect(packageJson.exports['./ui/hostApiClient']).toBeUndefined();
        expect(packageJson.exports['./experimental/scm']).toEqual({
            types: './dist/scm/index.d.ts',
            default: './dist/scm/index.js',
        });
        expect(packageJson.exports['./experimental/account-usage']).toEqual({
            types: './dist/accountUsage.d.ts',
            default: './dist/accountUsage.js',
        });
        expect(packageJson.exports['./experimental/hooks']).toEqual({
            types: './dist/hooks.d.ts',
            default: './dist/hooks.js',
        });
        expect(packageJson.exports['./experimental/mcp']).toEqual({
            types: './dist/mcp.d.ts',
            default: './dist/mcp.js',
        });
        expect(packageJson.exports['./experimental/reviews']).toEqual({
            types: './dist/reviews/index.d.ts',
            default: './dist/reviews/index.js',
        });
        expect(packageJson.exports['./experimental/sessions']).toEqual({
            types: './dist/sessions/index.d.ts',
            default: './dist/sessions/index.js',
        });
        for (const accidental of [
            './acp',
            './agent-runtime-v1',
            './agents',
            './events',
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
            './hooks',
            './mcp',
            './reviews',
            './scm',
            './sessions',
            './usage',
        ]) {
            expect(packageJson.exports[accidental], accidental).toBeUndefined();
        }
    });

    it('does not export the retired host-private single-shot execution runtime helper', async () => {
        const packageJson = JSON.parse(
            await readFile(new URL('../package.json', import.meta.url), 'utf8'),
        ) as PluginSdkPackageJson;

        expect(packageJson.exports['./experimental/executionRuns/singleShot']).toBeUndefined();
    });

    it('keeps the curated SDK on prepublication hold', async () => {
        const packageJson = JSON.parse(
            await readFile(new URL('../package.json', import.meta.url), 'utf8'),
        ) as PluginSdkPackageJson;
        const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

        expect(packageJson.version).toBe('0.0.0');
        expect(packageJson.private).toBe(true);
        expect(packageJson.happier.publicSdkRelease).toMatchObject({
            posture: 'prepublish_hold',
            supportPolicy: 'README.md#public-sdk-release-posture',
            externalPublicationRequiresApproval: true,
        });
        expect(readme).toContain('## Public SDK release posture');
        expect(readme).toContain('Every public path is\n**Developer Preview** until 1.0');
        expect(readme).toContain(
            'a documented 0.x minor may include breaking changes with migration notes',
        );
        expect(readme).toContain(
            'This surface remains on prepublication hold until the\nconsolidated API receives explicit approval.',
        );
    });

    it('keeps the package root at the exact seven-symbol supported seed', async () => {
        for (const entrypoint of ['index.ts', 'index.browser.ts']) {
            const sourceText = await readFile(new URL(`./${entrypoint}`, import.meta.url), 'utf8');
            const sourceFile = ts.createSourceFile(
                entrypoint,
                sourceText,
                ts.ScriptTarget.Latest,
                true,
                ts.ScriptKind.TS,
            );
            const exportedNames = sourceFile.statements.flatMap((statement) => {
                if (!ts.isExportDeclaration(statement) || !statement.exportClause) return [];
                if (!ts.isNamedExports(statement.exportClause)) return [];
                return statement.exportClause.elements.map((element) => element.name.text);
            });

            expect(exportedNames.sort(), entrypoint)
                .toEqual([...NORMAL_SURFACE_ALLOWLIST['.']].sort());
        }
        expect(Object.keys(rootPublicApi)).toEqual(['PluginError']);
    });

    it('keeps file-follow path disclosure out of the experimental sessions bundle', async () => {
        const sourceText = await readFile(
            new URL('./sessions/index.ts', import.meta.url),
            'utf8',
        );
        const sourceFile = ts.createSourceFile(
            'sessions/index.ts',
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const exportedNames = sourceFile.statements.flatMap((statement) => {
            if (!ts.isExportDeclaration(statement) || !statement.exportClause) return [];
            if (!ts.isNamedExports(statement.exportClause)) return [];
            return statement.exportClause.elements.map((element) => element.name.text);
        });

        expect(exportedNames).not.toContain(
            'AgentExternalSessionsResolveFollowTranscriptPathRequest',
        );
        expect(exportedNames).not.toContain(
            'AgentExternalSessionsResolveFollowTranscriptPathResult',
        );
    });

    it('keeps retired rich-follow host contracts out of experimental sessions', async () => {
        const sourceText = await readFile(
            new URL('./sessions/index.ts', import.meta.url),
            'utf8',
        );
        const sourceFile = ts.createSourceFile(
            'sessions/index.ts',
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const exportedNames = sourceFile.statements.flatMap((statement) => {
            if (!ts.isExportDeclaration(statement) || !statement.exportClause) return [];
            if (!ts.isNamedExports(statement.exportClause)) return [];
            return statement.exportClause.elements.map((element) => element.name.text);
        });

        expect(exportedNames).toEqual(expect.arrayContaining([
            'AgentExternalSessionObservationContribution',
            'AgentExternalSessionsContribution',
            'ExternalSessionListCandidatesParamsV1',
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
        ]) {
            expect(exportedNames, retired).not.toContain(retired);
        }
    });

    it('exports only the canonical takeover contracts from experimental sessions', async () => {
        const sourceText = await readFile(
            new URL('./sessions/index.ts', import.meta.url),
            'utf8',
        );
        const sourceFile = ts.createSourceFile(
            'sessions/index.ts',
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const exportedNames = sourceFile.statements.flatMap((statement) => {
            if (!ts.isExportDeclaration(statement) || !statement.exportClause) return [];
            if (!ts.isNamedExports(statement.exportClause)) return [];
            return statement.exportClause.elements.map((element) => element.name.text);
        });

        expect(exportedNames.filter((name) => name.includes('Takeover')).sort()).toEqual([
            'AgentExternalSessionTakeoverContribution',
            'AgentExternalSessionTakeoverLaunchPlan',
            'AgentExternalSessionTakeoverResolveLaunchCallback',
            'AgentExternalSessionTakeoverResolveLaunchRequest',
            'AgentExternalSessionTakeoverResolveLaunchResult',
            'ExternalSessionTakeoverInputV1',
            'ExternalSessionTakeoverResultV1',
            'validateAgentExternalSessionTakeoverContribution',
            'validateAgentExternalSessionTakeoverLaunchPlan',
            'validateAgentExternalSessionTakeoverResolveLaunchRequest',
            'validateAgentExternalSessionTakeoverResolveLaunchResult',
        ]);
        expect(exportedNames).not.toContain('resolveTakeoverSpawnOptions');
        expect(exportedNames).not.toContain('SpawnSessionOptions');
        expect(exportedNames).toContain('BackendSessionLaunchHintsV1');
    });

    it('exports the exact current C-V2 observation authoring types from experimental sessions', async () => {
        const sourceText = await readFile(
            new URL('./sessions/index.ts', import.meta.url),
            'utf8',
        );
        const sourceFile = ts.createSourceFile(
            'sessions/index.ts',
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const observationTypes = sourceFile.statements.flatMap((statement) => {
            if (!ts.isExportDeclaration(statement) || !statement.exportClause) return [];
            if (!ts.isNamedExports(statement.exportClause)) return [];
            return statement.exportClause.elements
                .map((element) => element.name.text)
                .filter((name) => name.includes('Observation'));
        });

        expect(observationTypes.sort()).toEqual([
            'AgentExternalSessionObservationContribution',
            'AgentExternalSessionObservationDescribeResourceRequest',
            'AgentExternalSessionObservationObserveResourceRequest',
            'AgentExternalSessionObservationReconcileLink',
            'AgentExternalSessionObservationReconcileResourceRequest',
            'ExternalAgentObservationLinkEvidenceBatchV1',
            'ExternalAgentObservationLinkKeyV1',
            'ExternalAgentObservationReconcilePurposeV1',
            'ExternalAgentObservationReconcileRequestV1',
            'ExternalAgentObservationReconcileResultV1',
            'ExternalAgentObservationResourceDescriptorOutcomeV1',
            'ExternalAgentObservationResourceDescriptorV1',
            'ExternalAgentObservationResourceGroupingV1',
            'ExternalAgentObservationResourceKeyV1',
            'ExternalAgentObservationWatchFileChangesV1',
        ]);
    });

    it('keeps the normal testing path limited to the real test host and shared registration boundary', () => {
        expect(Object.keys(testingPublicApi).sort()).toEqual([
            'createPluginTestkit',
        ]);
    });
});
