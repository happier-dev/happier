import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

const packaged = vi.hoisted(() => ({ bytes: new Uint8Array(), githubBytes: new Uint8Array(), githubAccountBytes: new Uint8Array(),
    channelsAccountBytes: new Uint8Array(), detailBytes: new Uint8Array(), pageBytes: new Uint8Array(), sessionEntriesBytes: new Uint8Array(), mountedBytes: new Uint8Array(), machineRpc: vi.fn() }));

// Only packaged-asset IO is substituted. Compile the current authored Account
// entry with its production compiler; admission, activation and dispatch stay real.
vi.mock('./generatedBundledPluginUiArtifacts', async () => {
    const { resolve, join } = await import('node:path');
    const { compileUniversalPluginUiCommonJs } = await import('../../../../../../../packages/plugin-sdk/src/ui/build/universalCommonJsCompiler');
    const { readWorkspacePackages, packageNameOfSpecifier, resolveWorkspaceSource } = await import('../../../../../../../packages/cli-common/sourceRuntimeEntries.mjs');
    // Load foreign-program source under Vitest without making the UI compiler
    // root the daemon entry's whole source graph; the public schema admits it.
    const triageManifestSource = '../../../../../../../packages/plugins/triage/src/manifest';
    const { PLUGIN_MANIFEST } = await vi.importActual<Readonly<{ PLUGIN_MANIFEST: unknown }>>(triageManifestSource);
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1,
        PluginUiArtifactsManifestEntryV2Schema } = await import('@happier-dev/protocol/plugins/ui');
    const { projectPluginPortableUiDeclarationsV1 } = await import('@happier-dev/protocol/plugins/contributions/ui');
    const { normalizePluginAccountCollectionContractV1} = await import('@happier-dev/protocol/plugins/data/collectionsV1');
    const root = resolve(process.cwd(), '../..');
    const packages = await readWorkspacePackages(root);
    const projectRoot = join(root, 'packages/plugins/triage');
    const compiled = await compileUniversalPluginUiCommonJs({ projectRoot,
        entryPath: join(projectRoot, 'src/accountRuntime.ts'), artifactId: 'triage-account-runtime',
        requestedExports: ['activate'], exportConditions: ['happier-source'],
        resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
            ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
    });
    packaged.bytes = compiled.bytes;
    const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST);
    const collectionContracts = manifest.contributes.accountCollections.map(contribution => {
        const contract = normalizePluginAccountCollectionContractV1({ pluginId: manifest.id, contribution });
        return { pluginId: contract.pluginId, collectionId: contract.collectionId,
            schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest };
    });
    const relativePath = 'react-native/triage-account-runtime/entry.cjs.bundle';
    const artifact = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'triage-account-runtime', tier: 'reactNative',
        entry: relativePath, digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath, bytes: compiled.bytes }]),
        files: [{ relativePath, digest: computePluginUiArtifactSha256DigestV1(compiled.bytes), byteSize: compiled.bytes.byteLength }],
        builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['activate'] }, hostUiApiRange: '^1.0.0' });
    const detailCompiled = await compileUniversalPluginUiCommonJs({ projectRoot,
        entryPath: join(projectRoot, 'src/internalTasks/detail.tsx'), artifactId: 'triage-internal-task-detail-native',
        requestedExports: ['renderSurface'], exportConditions: ['happier-source'],
        resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
            ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
    });
    const detailPath = 'react-native/triage-internal-task-detail-native/entry.cjs.bundle';
    packaged.detailBytes = detailCompiled.bytes;
    const detailArtifact = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'triage-internal-task-detail-native', tier: 'reactNative',
        entry: detailPath, digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: detailPath, bytes: detailCompiled.bytes }]),
        files: [{ relativePath: detailPath, digest: computePluginUiArtifactSha256DigestV1(detailCompiled.bytes), byteSize: detailCompiled.bytes.byteLength }],
        builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0' });
    const pageCompiled = await compileUniversalPluginUiCommonJs({ projectRoot,
        entryPath: join(projectRoot, 'src/ui/tasksSurface.tsx'), artifactId: 'triage-tasks-page-native',
        requestedExports: ['renderSurface'], exportConditions: ['happier-source'],
        resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
            ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
    });
    packaged.pageBytes = pageCompiled.bytes;
    const pagePath = 'react-native/triage-tasks-page-native/entry.cjs.bundle';
    const pageArtifact = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'triage-tasks-page-native', tier: 'reactNative',
        entry: pagePath, digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: pagePath, bytes: pageCompiled.bytes }]),
        files: [{ relativePath: pagePath, digest: computePluginUiArtifactSha256DigestV1(pageCompiled.bytes), byteSize: pageCompiled.bytes.byteLength }],
        builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0' });
    const mountedCompiled = await compileUniversalPluginUiCommonJs({ projectRoot,
        entryPath: join(projectRoot, 'src/actions/mountedUi.ts'), artifactId: 'triage-mounted-ui-action-native',
        requestedExports: ['activate'], exportConditions: ['happier-source'],
        resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
            ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
    });
    packaged.mountedBytes = mountedCompiled.bytes;
    const mountedPath = 'react-native/triage-mounted-ui-action-native/entry.cjs.bundle';
    const mountedArtifact = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: mountedCompiled.artifactId, tier: 'reactNative',
        entry: mountedPath, digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: mountedPath, bytes: mountedCompiled.bytes }]),
        files: [{ relativePath: mountedPath, digest: computePluginUiArtifactSha256DigestV1(mountedCompiled.bytes), byteSize: mountedCompiled.bytes.byteLength }],
        builtWith: { bundler: 'esbuild', version: mountedCompiled.esbuildVersion }, executable: { exports: ['activate'] }, hostUiApiRange: '^1.0.0' });
    const sessionEntriesCompiled = await compileUniversalPluginUiCommonJs({ projectRoot,
        entryPath: join(projectRoot, 'src/sessions/cockpit/sessionLinkedEntriesSurface.tsx'), artifactId: 'triage-session-entries-native',
        requestedExports: ['renderSurface'], exportConditions: ['happier-source'],
        resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
            ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
    });
    packaged.sessionEntriesBytes = sessionEntriesCompiled.bytes;
    const sessionEntriesPath = 'react-native/triage-session-entries-native/entry.cjs.bundle';
    const sessionEntriesArtifact = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: sessionEntriesCompiled.artifactId, tier: 'reactNative',
        entry: sessionEntriesPath, digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: sessionEntriesPath, bytes: sessionEntriesCompiled.bytes }]),
        files: [{ relativePath: sessionEntriesPath, digest: computePluginUiArtifactSha256DigestV1(sessionEntriesCompiled.bytes), byteSize: sessionEntriesCompiled.bytes.byteLength }],
        builtWith: { bundler: 'esbuild', version: sessionEntriesCompiled.esbuildVersion }, executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0' });
    const uiDeclaration = { pluginId: manifest.id, pluginVersion: manifest.version, displayName: manifest.displayName,
        packageName: '@happier-dev/plugins-triage', normalizedManifest: manifest, artifactGraphs: [artifact, detailArtifact, pageArtifact, mountedArtifact, sessionEntriesArtifact],
        collectionContracts,
        entriesById: projectPluginPortableUiDeclarationsV1(manifest, [artifact, detailArtifact, pageArtifact, mountedArtifact, sessionEntriesArtifact]),
        declaredExecution: { daemonActions: true, contributionPoints: true } };
    const githubManifestSource = '../../../../../../../packages/plugins/scm-github/src/manifest';
    const githubModule = await vi.importActual<Readonly<{ PLUGIN_MANIFEST: unknown }>>(githubManifestSource);
    const githubManifest = PluginPortableReleaseManifestV1Schema.parse(githubModule.PLUGIN_MANIFEST);
    const githubRoot = join(root, 'packages/plugins/scm-github');
    const githubCompiled = await compileUniversalPluginUiCommonJs({ projectRoot: githubRoot,
        entryPath: join(githubRoot, 'src/ui/renderSurface.tsx'), artifactId: 'github-detail-native',
        requestedExports: ['renderSurface'], exportConditions: ['happier-source'],
        resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
            ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
    });
    packaged.githubBytes = githubCompiled.bytes;
    const githubPath = 'react-native/github-detail-native/entry.cjs.bundle';
    const githubArtifact = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'github-detail-native', tier: 'reactNative',
        entry: githubPath, digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: githubPath, bytes: githubCompiled.bytes }]),
        files: [{ relativePath: githubPath, digest: computePluginUiArtifactSha256DigestV1(githubCompiled.bytes), byteSize: githubCompiled.bytes.byteLength }],
        builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0' });
    const githubAccountCompiled = await compileUniversalPluginUiCommonJs({ projectRoot: githubRoot,
        entryPath: join(githubRoot, 'src/accountRuntime.ts'), artifactId: 'github-account-runtime',
        requestedExports: ['activate'], exportConditions: ['happier-source'],
        resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
            ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
    });
    packaged.githubAccountBytes = githubAccountCompiled.bytes;
    const githubAccountPath = 'react-native/github-account-runtime/entry.cjs.bundle';
    const githubAccountArtifact = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'github-account-runtime', tier: 'reactNative',
        entry: githubAccountPath, digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: githubAccountPath, bytes: githubAccountCompiled.bytes }]),
        files: [{ relativePath: githubAccountPath, digest: computePluginUiArtifactSha256DigestV1(githubAccountCompiled.bytes), byteSize: githubAccountCompiled.bytes.byteLength }],
        builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['activate'] }, hostUiApiRange: '^1.0.0' });
    const githubDeclaration = { pluginId: githubManifest.id, pluginVersion: githubManifest.version, displayName: githubManifest.displayName,
        packageName: '@happier-dev/plugins-scm-github', normalizedManifest: githubManifest, artifactGraphs: [githubArtifact, githubAccountArtifact],
        entriesById: projectPluginPortableUiDeclarationsV1(githubManifest, [githubArtifact, githubAccountArtifact]) };
    const channelsManifestSource = '../../../../../../../packages/plugins/channels/src/manifest';
    const channelsModule = await vi.importActual<Readonly<{ PLUGIN_MANIFEST: unknown }>>(channelsManifestSource);
    const channelsManifest = PluginPortableReleaseManifestV1Schema.parse(channelsModule.PLUGIN_MANIFEST);
    const channelsRoot = join(root, 'packages/plugins/channels');
    const channelsCompiled = await compileUniversalPluginUiCommonJs({ projectRoot: channelsRoot,
        entryPath: join(channelsRoot, 'src/accountRuntime.ts'), artifactId: 'channels-account-runtime',
        requestedExports: ['activate'], exportConditions: ['happier-source'],
        resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
            ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
    });
    packaged.channelsAccountBytes = channelsCompiled.bytes;
    const channelsPath = 'react-native/channels-account-runtime/entry.cjs.bundle';
    const channelsArtifact = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'channels-account-runtime', tier: 'reactNative',
        entry: channelsPath, digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: channelsPath, bytes: channelsCompiled.bytes }]),
        files: [{ relativePath: channelsPath, digest: computePluginUiArtifactSha256DigestV1(channelsCompiled.bytes), byteSize: channelsCompiled.bytes.byteLength }],
        builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['activate'] }, hostUiApiRange: '^1.0.0' });
    const channelsDeclaration = { pluginId: channelsManifest.id, pluginVersion: channelsManifest.version, displayName: channelsManifest.displayName,
        packageName: '@happier-dev/plugins-channels', normalizedManifest: channelsManifest, artifactGraphs: [channelsArtifact],
        collectionContracts: channelsManifest.contributes.accountCollections.map(contribution => {
            const contract = normalizePluginAccountCollectionContractV1({ pluginId: channelsManifest.id, contribution });
            return { pluginId: contract.pluginId, collectionId: contract.collectionId,
                schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest };
        }),
        entriesById: projectPluginPortableUiDeclarationsV1(channelsManifest, [channelsArtifact]),
        declaredExecution: { daemonActions: true, contributionPoints: true } };
    return { BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [uiDeclaration, githubDeclaration, channelsDeclaration].map(declaration => ({
        ...declaration, normalizedManifest: undefined, presentationManifest: declaration.normalizedManifest,
        loadDeclaration: async () => declaration,
    })),
        BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [{ pluginId: manifest.id, releaseVersion: manifest.version,
        artifactId: artifact.artifactId, tier: artifact.tier, digest: artifact.digest, artifactGraph: artifact,
        files: [{ relativePath, asset: 1 }] }, { pluginId: githubManifest.id, releaseVersion: githubManifest.version,
        artifactId: githubArtifact.artifactId, tier: githubArtifact.tier, digest: githubArtifact.digest, artifactGraph: githubArtifact,
        files: [{ relativePath: githubPath, asset: 2 }] }, { pluginId: githubManifest.id, releaseVersion: githubManifest.version,
        artifactId: githubAccountArtifact.artifactId, tier: githubAccountArtifact.tier, digest: githubAccountArtifact.digest, artifactGraph: githubAccountArtifact,
        files: [{ relativePath: githubAccountPath, asset: 5 }] }, { pluginId: channelsManifest.id, releaseVersion: channelsManifest.version,
        artifactId: channelsArtifact.artifactId, tier: channelsArtifact.tier, digest: channelsArtifact.digest, artifactGraph: channelsArtifact,
        files: [{ relativePath: channelsPath, asset: 6 }] }, { pluginId: manifest.id, releaseVersion: manifest.version,
        artifactId: mountedArtifact.artifactId, tier: mountedArtifact.tier, digest: mountedArtifact.digest, artifactGraph: mountedArtifact,
        files: [{ relativePath: mountedPath, asset: 7 }] }, { pluginId: manifest.id, releaseVersion: manifest.version,
        artifactId: sessionEntriesArtifact.artifactId, tier: sessionEntriesArtifact.tier, digest: sessionEntriesArtifact.digest, artifactGraph: sessionEntriesArtifact,
        files: [{ relativePath: sessionEntriesPath, asset: 9 }] }, ...[detailArtifact, pageArtifact].map((graph, index) => ({
            pluginId: manifest.id, releaseVersion: manifest.version, artifactId: graph.artifactId, tier: graph.tier,
            digest: graph.digest, artifactGraph: graph, files: [{ relativePath: graph.entry, asset: index + 3 }],
        }))], BUNDLED_PLUGIN_BRAND_MARKS: [] };
});
vi.mock('expo-asset', () => ({ Asset: { fromModule: (asset: number) => ({ localUri: `file:///test-app/${asset}.bundle`,
    downloadAsync: async () => undefined }) } }));
vi.mock('expo-file-system', () => ({ File: class {
    exists = true;
    constructor(private readonly uri: string) {}
    bytes = async () => this.uri.endsWith('/9.bundle') ? packaged.sessionEntriesBytes
        : this.uri.endsWith('/7.bundle') ? packaged.mountedBytes
        : this.uri.endsWith('/6.bundle') ? packaged.channelsAccountBytes
        : this.uri.endsWith('/5.bundle') ? packaged.githubAccountBytes
        : this.uri.endsWith('/2.bundle') ? packaged.githubBytes
        : this.uri.endsWith('/3.bundle') ? packaged.detailBytes
            : this.uri.endsWith('/4.bundle') ? packaged.pageBytes : packaged.bytes;
} }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    // The user-presentation boundary approves the real present-user gate.
    return createModalModuleMock({ confirmResult: true, renderCustomModals: true }).module;
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(async input => {
        const reply = packaged.machineRpc(input);
        if (reply !== undefined) return reply;
        throw new Error('No Machine is selected');
    });
});

// Expo is the native HTTP leaf; keep the same real Account request harness.
vi.mock('expo/fetch', async () => (await import('@/dev/testkit/mocks/expoFetch'))
    .createExpoFetchModuleMock((input, init) => account.home.request(input, init)));

const account = createProviderSettingsAccountHarness();
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { SessionRightSidebarProvider, SessionActionRail } = await import('@/components/sessions/panes/SessionRightPanel');
const { RightSidebarActionRail } = await import('@/components/appShell/rightSidebar/RightSidebarActionRail');
const { useSessionPluginRuntime, createSessionPaneSurfaceScope } = await import('@/components/sessions/plugins/useSessionPluginRuntime');
const { AppSessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/appSessionTranscriptSource');
const { PluginContextualResourceStoreProvider } = await import('@/components/plugins/surfaces/PluginContextualResourceStoreProvider');
const { useChatListRootState } = await import('@/components/sessions/transcript/useChatListRootState');
const { PluginMessageActionHostProvider, PluginMessageActions } = await import('@/components/sessions/transcript/messageActions/PluginMessageActions');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { storage } = await import('@/sync/domains/state/storage');
const { AppShellPluginUiProjectionProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
const { PluginAppPageScreen } = await import('@/components/appShell/plugins/PluginAppPageScreen');
const { readCurrentAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('./projection');
const { resolvePluginUiClientActionRegistration } = await import('@/components/plugins/reactNative/clientExecutableContributions');
const { readPluginUiAccountExecutableOrigin } = await import('@/components/plugins/reactNative/executableModuleHost');
const { createPluginUiProjectedActionResolver } = await import('@/sync/domains/plugins/ui/projection');
const { createBoundPluginSurfaceController } = await import('@/components/plugins/surfaces/boundPluginSurfaceController');
const { BUNDLED_PLUGIN_UI_APP_DECLARATIONS } = await import('./generatedBundledPluginUiArtifacts');
const { PluginAccountAvailabilityIntentReadResponseV1Schema } = await import('@happier-dev/protocol/plugins/availability');
const { normalizePluginAccountCollectionContractV1, PluginCollectionGetRequestV1Schema, PluginCollectionQueryRequestV1Schema, PluginCollectionContractReadRequestV1Schema, PluginCollectionRowV1Schema} = await import('@happier-dev/protocol/plugins/data/collectionsV1');
const { scopedHomeActionExecutor } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
const { encodeBase64StoredJsonContentEnvelope, decodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
const { TaskResourceV1Schema, TaskResourcesListResponseV1Schema } = await import('../../../../../../../packages/protocol/src/todos/taskResourceV1');
const { createTestkitCorpusCollections } = await import('../../../../../../../packages/plugins/triage/src/corpus/testkit/corpusCollections.test-support');
const { administerConfiguredSourceInstance } = await import('../../../../../../../packages/plugins/triage/src/corpus/configuration/administerConfiguredSourceInstance');
const { INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1 } = await import('../../../../../../../packages/plugins/triage/src/internalTasks/source');
const { INTERNAL_TASK_SOURCE_RECORD_V1 } = await import('../../../../../../../packages/plugins/triage/src/internalTasks/configuration');
const { encodePluginCollectionLogicalValueV1 } = await import('@happier-dev/protocol/plugins/data/collectionLogicalCodecV1');
const { compilePluginJsonSchema, isValidPluginJsonSchemaValue } = await import('@happier-dev/plugin-sdk/manifest');
const { TriageTaskWriteResultV1Schema } = await import('@happier-dev/triage-protocol/v1');
const { GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1, GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1, GITHUB_TRIAGE_ACTION_IDS_V1 } = await import('../../../../../../../packages/plugins/scm-github/src/triage/contribution');
const { encodeGithubTriageConfiguration, GITHUB_TRIAGE_ACCOUNT_SCOPE_V1 } = await import('../../../../../../../packages/plugins/scm-github/src/triage/configuration');
const { GITHUB_TEST_ACCOUNT } = await import('../../../../../../../packages/plugins/scm-github/src/triage/testkit/githubTriage.test-support');
const { githubNativeReadActionId } = await import('../../../../../../../packages/plugins/scm-github/src/triage/readActions');
const { GITHUB_PLUGIN_ID } = await import('../../../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts');
const { Modal } = await import('@/modal');
const kvMutationsSchema = z.strictObject({ mutations: z.array(z.strictObject({
    key: z.string(), value: z.nullable(z.string()), version: z.number(),
})) });

it.each(['own', 'foreign', 'missing-purpose'] as const)('opens the E2EE GitHub source Account sheet: %s', async ownership => {
    await account.restore({ accountId: 'source-owner', machines: [], e2eeSecret: new Uint8Array(32).fill(9),
        waivedActions: ['connectedServices.purposes.default.set'],
        serverIdentityId: 'srv_source_account_sheet', features: createRootLayoutFeaturesResponse({ capabilities: {
            connectedServices: { credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion: 4 } },
        } }) });
    const lifetime = captureActiveServerAccountScopeLifetime()!;
    const github = BUNDLED_PLUGIN_UI_APP_DECLARATIONS[1]!;
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
        availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId: GITHUB_PLUGIN_ID,
            response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
                hostingCapability: { enabled: false }, intent: { pluginId: GITHUB_PLUGIN_ID, desiredVersion: null,
                    enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'source-sheet' },
                release: null, packageAssets: [], uiArtifacts: [] }) }],
    } });
    const githubSelection = await readPluginAccountAvailability(lifetime.scope).ensureCurrentAccountExecution(github.pluginId);
    if (githubSelection.kind !== 'available') throw new Error('GitHub Account manifest unavailable');
    const authentication = githubSelection.manifest.contributes.connectedAccountDescriptors
        .find(descriptor => descriptor.id === GITHUB_TEST_ACCOUNT.service.localId)?.authentication;
    expect(authentication).toBeDefined();
    const { ConnectedAccountCatalogRowMutationV1Schema } = await import('@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1');
    let purposeWrites = 0;
    let purposeContent: unknown;
    account.home.answer(account.serverId, 'GET /v1/account/entity-rows/connected-accounts/purposes', { select: () => ({ body:
        purposeWrites === 0 ? { status: 'absent' } : { status: 'present', revision: purposeWrites, content: purposeContent } }) });
    account.home.answer(account.serverId, 'POST /v1/account/entity-rows/connected-accounts/purposes', { select: body => {
        const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(body);
        expect(mutation.content?.t).toBe('encrypted');
        purposeContent = mutation.content;
        purposeWrites++;
        return { body: { status: 'updated', revision: purposeWrites, cursor: purposeWrites } };
    } });
    const { QualifiedConnectedAccountProfileV4Schema } = await import('@happier-dev/protocol/connect/qualified-connected-account-projections');
    storage.getState().applyProfile({ ...storage.getState().profile, id: lifetime.scope.accountId,
        connectedAccountsV4: [QualifiedConnectedAccountProfileV4Schema.parse({ ref: GITHUB_TEST_ACCOUNT,
            status: 'connected', kind: 'token', authenticationModeId: authentication!.defaultModeId, revisionSemantics: 'revisioned',
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', configurationReady: true,
            configurationRevision: null, scopes: [], displayName: 'Source owner GitHub' })] });
    const { ConnectSheetContent } = await import('@/components/settings/connectedServices/setup/ConnectSheetContent');
    const { renderScreen } = await import('@/dev/testkit');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentials();
    const scope = ownership === 'foreign' ? { ...lifetime.scope, accountId: 'another-person' } : lifetime.scope;
    const { ModalProvider } = await import('@/modal');
    const settled = vi.fn();
    const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><AppShellPluginUiProjectionProvider><ModalProvider>
        <ConnectSheetContent onClose={() => undefined} onResult={settled} request={{ scope,
            service: GITHUB_TEST_ACCOUNT.service, purposeSettlement: 'resourceDefault',
            purposeRequest: { scope, purpose: { consumer: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances },
                purpose: ownership === 'missing-purpose' ? 'undeclared-purpose' : GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.purpose } } }} />
    </ModalProvider></AppShellPluginUiProjectionProvider></InjectedAuthProvider>);
    try {
        if (ownership === 'own') {
            await vi.waitFor(() => expect(screen.findByTestId('connect-sheet:purpose')).not.toBeNull());
            expect(screen.findByTestId('connect-sheet:unavailable')).toBeNull();
            expect(screen.findByTestId(`connected-account-purpose:${GITHUB_TEST_ACCOUNT.service.pluginId}/${GITHUB_TEST_ACCOUNT.service.localId}`)).not.toBeNull();
            const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
            const { createUiConnectedServiceAction } = await import('@/sync/ops/actions/connectedServiceActionDeps');
            const { getConnectedAccountCatalogValue } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
            const action = createUiConnectedServiceAction(await captureLazyActionAccountContext(lifetime.scope.serverId));
            const purpose = { consumer: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances },
                purpose: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.purpose };
            const target = { kind: 'account' as const, account: GITHUB_TEST_ACCOUNT };
            const { connectedAccountPurposeTargetChoiceId } = await import('@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices');
            await vi.waitFor(() => expect(getConnectedAccountCatalogValue(lifetime.scope, 'purposes')).toMatchObject({ status: 'ready', stale: false }));
            const pickerId = `connected-account-purpose:${GITHUB_TEST_ACCOUNT.service.pluginId}/${GITHUB_TEST_ACCOUNT.service.localId}`;
            await vi.waitFor(() => expect(screen.findByTestId(pickerId)?.props.disabled).not.toBe(true));
            await screen.pressByTestIdAsync(pickerId);
            expect(Modal.show).toHaveBeenCalled();
            await vi.waitFor(() => expect(screen.findByTestId(`${pickerId}:choice:${connectedAccountPurposeTargetChoiceId(target)}`)).not.toBeNull());
            expect(screen.findByTestId(`${pickerId}:choice:${connectedAccountPurposeTargetChoiceId(target)}`)?.props).toMatchObject({ disabled: false });
            await screen.pressByTestIdAsync(`${pickerId}:choice:${connectedAccountPurposeTargetChoiceId(target)}`);
            await vi.waitFor(() => expect({ settled: settled.mock.calls.length, purposeWrites,
                alerts: vi.mocked(Modal.alert).mock.calls.map(args => args.slice(0, 2)) }).toEqual({ settled: 1, purposeWrites: 2, alerts: [] }));
            expect(purposeWrites).toBe(2); // Empty catalog initialization, then the person's selection.
            expect(getConnectedAccountCatalogValue(lifetime.scope, 'purposes').value?.bindings).toEqual([{ purpose, target }]);
            await expect(action({ actionId: 'connectedServices.purposes.default.set', input: { purpose,
                target: { kind: 'account', account: { ...GITHUB_TEST_ACCOUNT, accountId: 'foreign-credential' } } },
                context: { surface: 'ui', authority: 'present_user' } })).resolves.toMatchObject({ ok: false,
                    errorCode: 'connected_account_purpose_unavailable' });
            expect(purposeWrites).toBe(2);
        } else {
            const refusal = screen.findByTestId('connect-sheet:unavailable');
            expect(refusal).not.toBeNull();
            const code = ownership === 'foreign' ? 'account_scope_mismatch' : 'purpose_unavailable';
            expect(screen.findByTestId(`connect-sheet:unavailable-diagnostic-${code}`)).not.toBeNull();
            expect(screen.findByTestId('connect-sheet:purpose')).toBeNull();
        }
        expect(packaged.machineRpc).not.toHaveBeenCalled();
    } finally { await screen.unmount(); }
});

it('publishes late Account linked work and selected message Actions to the real Session without a Machine and retires exact Home custody', async () => {
    await account.restore({ machines: [], serverIdentityId: 'srv_triage_session_account',
        features: createRootLayoutFeaturesResponse({ features: { plugins: { enabled: true,
            ui: { enabled: true, hostedWeb: { enabled: true }, reactNativeBundles: { enabled: true } } } } }) });
    const lifetime = captureActiveServerAccountScopeLifetime()!;
    const declaration = BUNDLED_PLUGIN_UI_APP_DECLARATIONS[0]!;
    const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
    const { selectPluginRightSidebarTabPlacements } = await import('@/sync/domains/plugins/ui/surfacePlacementSelectors');
    const { buildPluginSurfaceDestinationId } = await import('@/components/plugins/surfaces/pluginSurfaceDestinations');
    const linkedWorkTabId = buildPluginSurfaceDestinationId(declaration.pluginId, 'session-entries');
    const { TRIAGE_TASKS_OPEN_CREATE_ACTION_LOCAL_ID_V1 } = await import('../../../../../../../packages/plugins/triage/src/actions/tasksProtocol');
    const address = { serverId: account.serverId, sessionId: 'account-only-session' };
    const { createSessionFixture, createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const session = createSessionFixture({ id: address.sessionId, serverId: lifetime.scope.serverId, active: true,
        metadata: { path: '/fixture/account-only', host: 'offline-machine' } });
    storage.getState().applySessions([session]);
    storage.getState().applyServerScopedSessionListRows(address.serverId,
        [createSessionListRenderableSessionFixture(session)], { source: 'rowOnly', mode: 'append' });
    expect(storage.getState().sessionListRowsByServerId[session.serverId!]?.[session.id]?.access?.role).toBe('owner');
    const reference = { v: 1, sessionId: session.id, messageId: 'account-assistant-message', observedRevision: 'message-1' } as const;
    let messageHost: ReturnType<typeof useChatListRootState>['pluginMessageActionHost'];
    function SelectedMessageEntry() {
        const { pluginMessageActionHost } = useChatListRootState({ session, sessionSurfaceKey: session.id });
        messageHost = pluginMessageActionHost;
        return <PluginMessageActionHostProvider host={pluginMessageActionHost}>
            <PluginMessageActions messageActionReference={reference} invertedActionsLayout={false} />
        </PluginMessageActionHostProvider>;
    }
    let runtime: ReturnType<typeof useSessionPluginRuntime> | undefined;
    function SessionEntry(props: Readonly<{ registered?: boolean; serverId?: string }>) {
        const target = { ...address, serverId: props.serverId ?? address.serverId };
        const current = useSessionPluginRuntime({ address: target });
        runtime = current;
        return <SessionRightSidebarProvider sessionId={target.sessionId}
            scopeId={createSessionPaneScopeId(target.sessionId, target.serverId)}
            {...(props.registered ? { paneSurfaceScope: createSessionPaneSurfaceScope(target.sessionId, current) } : {})}>
            <SessionActionRail />
            {props.serverId === undefined ? <AppSessionTranscriptSourceProvider sessionId={session.id}
                serverId={session.serverId} navigation="none"><PluginContextualResourceStoreProvider>
                <SelectedMessageEntry />
            </PluginContextualResourceStoreProvider></AppSessionTranscriptSourceProvider> : null}
        </SessionRightSidebarProvider>;
    }
    const scene = (registered = false, serverId?: string) => <AppShellPluginUiProjectionProvider><AppPaneProvider>
        <SessionEntry registered={registered} serverId={serverId} />
    </AppPaneProvider></AppShellPluginUiProjectionProvider>;
    const screen = await renderWithAppProviders(scene());
    const linkedTabs = () => screen.tree.root.findByType(RightSidebarActionRail).props.actions
        .filter((action: Readonly<{ id: string }>) => action.id.includes('happier.triage'));
    try {
        expect(linkedTabs()).toEqual(expect.arrayContaining([expect.objectContaining({ id: linkedWorkTabId })]));
        const snapshot = { availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId: declaration.pluginId,
            response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
                hostingCapability: { enabled: false }, intent: { pluginId: declaration.pluginId, desiredVersion: null,
                    enabled: true, offlineUiHosting: 'disabled', writableCollections: declaration.collectionContracts, revision: 'session-catalog' },
                release: null, packageAssets: [], uiArtifacts: [] }) }] };
        const disabled = { ...snapshot, intentReads: snapshot.intentReads.map(read => ({ ...read,
            response: { ...read.response, intent: { ...read.response.intent!, enabled: false } },
        })) };
        await act(async () => { replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: disabled }); });
        await flushHookEffects();
        expect(linkedTabs()).toEqual([]);
        await act(async () => { replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot }); });
        await readPluginAccountAvailability(lifetime.scope).ensureCurrentAccountExecution(declaration.pluginId);
        const produced = readPluginAccountAvailability(lifetime.scope).readUiProjectionInputs()!.accountUiProjection!;
        expect(selectPluginRightSidebarTabPlacements(produced, 'session').map(row => row.binding.destination.localId))
            .toContain('session-entries');
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect({ phase: runtime?.phase, interactionEnabled: runtime?.interactionEnabled,
                serverId: runtime?.serverId, hasAccountLifetime: runtime?.accountLifetime !== null,
                hasProjection: runtime?.pluginUiProjection !== null, reason: runtime?.unavailableReasonCode })
                .toEqual({ phase: 'current', interactionEnabled: true, serverId: account.serverId,
                    hasAccountLifetime: true, hasProjection: true, reason: undefined });
        });
        const scopedPlacements = selectPluginRightSidebarTabPlacements(runtime!.pluginUiProjection!, 'session');
        expect(scopedPlacements.map(row => ({ id: row.binding.destination.localId, availability: row.availability })))
            .toEqual(selectPluginRightSidebarTabPlacements(produced, 'session')
                .map(row => ({ id: row.binding.destination.localId, availability: row.availability })));
        const { resolveRightSidebarPluginTabs } = await import('@/components/appShell/rightSidebar/rightSidebarPluginTabs');
        expect(resolveRightSidebarPluginTabs({ scope: 'session', placements: scopedPlacements }).map(tab => tab.id),
            JSON.stringify(scopedPlacements.map(row => ({ id: row.binding.destination.localId,
                availability: row.availability, display: row.display, policy: row.policy }))))
            .toContain(linkedWorkTabId);
        expect(messageHost?.resolveCurrent(reference) ?? null, 'the exact owner transcript must publish its Account Action host').not.toBeNull();
        const expectLinkedWork = async () => {
            await flushHookEffects();
            expect(linkedTabs()).toEqual(expect.arrayContaining([expect.objectContaining({ id: linkedWorkTabId })]));
        };
        await expectLinkedWork();
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            const menu = screen.tree.root.findAllByType(DropdownMenu).find(node =>
                node.props.items?.some((item: Readonly<{ id: string }>) => item.id === `happier.triage/${TRIAGE_TASKS_OPEN_CREATE_ACTION_LOCAL_ID_V1}`));
            expect(menu, 'the selected assistant message must offer Create task without daemon authority').toBeDefined();
        });
        expect(runtime).toMatchObject({ machineId: null, serverId: account.serverId, interactionEnabled: true, phase: 'current' });
        expect(runtime?.pluginUiProjection?.actionsById[`happier.triage/${TRIAGE_TASKS_OPEN_CREATE_ACTION_LOCAL_ID_V1}`]).toBeDefined();
        const originalMessageHost = messageHost;
        expect(originalMessageHost?.resolveCurrent(reference)).not.toBeNull();
        const stable = runtime?.pluginUiProjection;
        await act(async () => { replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot }); });
        await flushHookEffects();
        expect(runtime?.pluginUiProjection).toBe(stable);
        await screen.update(scene(true));
        expect(linkedTabs()).toEqual(expect.arrayContaining([expect.objectContaining({ id: linkedWorkTabId })]));
        await screen.update(scene(false, 'unknown-home'));
        expect(linkedTabs()).toEqual([]);
        expect(runtime?.pluginUiProjection).toBeNull();
        expect(originalMessageHost?.signal?.aborted).toBe(true);
        await screen.update(scene(true));
        expect(linkedTabs()).toHaveLength(1);
        await act(async () => { replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: disabled }); });
        await flushHookEffects();
        expect(linkedTabs()).toEqual([]);
        await act(async () => { replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot }); });
        await waitForHomeGovernance(async () => { await flushHookEffects(); expect(linkedTabs()).toHaveLength(1); });
        const resumedMessageHost = messageHost;
        expect(resumedMessageHost?.signal?.aborted).toBe(false);
        await act(async () => { await account.reset(); });
        await flushHookEffects();
        expect(lifetime.isCurrent()).toBe(false);
        expect(linkedTabs()).toEqual([]);
        expect(resumedMessageHost?.signal?.aborted).toBe(true);
        expect(packaged.machineRpc).not.toHaveBeenCalled();
    } finally { await screen.unmount(); }
});

afterEach(async () => {
    clearPluginAccountAvailabilityProjection();
    await account.reset();
    storage.setState(storage.getInitialState(), true);
    packaged.machineRpc.mockReset();
    vi.mocked(Modal.show).mockClear();
});

const TRIAGE_ACCOUNT_DISPATCH_SCENARIOS = ['client mounted E2EE', 'Account GitHub detail plain', 'Account GitHub detail E2EE', 'Account GitHub Session plain', 'Account GitHub Session E2EE', 'mixed sources', 'personal CRUD', 'personal detail', 'personal search', 'Home search', 'unavailable optional Machine', 'available Machine sources', 'available Machine linked Resource'] as const;

async function prepareTriageAccountDispatchScenario(scenario: typeof TRIAGE_ACCOUNT_DISPATCH_SCENARIOS[number] | 'personal send picker' | 'personal host controls') {
    const hostControls = scenario === 'personal host controls';
    const personalDetail = scenario === 'personal detail' || scenario === 'personal send picker' || hostControls;
    const availableMachine = scenario === 'available Machine sources' || scenario === 'available Machine linked Resource' || scenario === 'Home search';
    const sessionGithub = scenario === 'Account GitHub Session plain' || scenario === 'Account GitHub Session E2EE';
    const withMachine = scenario === 'unavailable optional Machine' || availableMachine || sessionGithub;
    const accountGithub = scenario === 'Account GitHub detail plain' || scenario === 'Account GitHub detail E2EE' || sessionGithub;
    const e2eeSecret = scenario === 'client mounted E2EE' || scenario === 'Account GitHub detail E2EE' || scenario === 'Account GitHub Session E2EE' ? new Uint8Array(32).fill(9) : undefined;
    const withGithub = scenario === 'mixed sources' || availableMachine || accountGithub;
    const machineId = 'optional-unavailable-machine';
    const machineOccurrenceId = 'github-current';
    await account.restore({ e2eeSecret, machines: withMachine ? [createMachineFixture({ id: machineId, active: availableMachine || sessionGithub, activeAt: availableMachine || sessionGithub ? Date.now() : 0 })] : [], serverIdentityId: 'srv_triage_account_dispatch',
        features: createRootLayoutFeaturesResponse({ features: { plugins: { enabled: true,
            ui: { enabled: true, hostedWeb: { enabled: true }, reactNativeBundles: { enabled: true } } } } }) });
    const lifetime = captureActiveServerAccountScopeLifetime()!;
    const declaration = BUNDLED_PLUGIN_UI_APP_DECLARATIONS[0]!;
    if (scenario === 'available Machine linked Resource' || sessionGithub) {
        const { createSessionFixture, createPlainSessionByIdResponseFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const session = createSessionFixture({ id: 'linked-resource-session',
            metadata: { path: '/fixture/repository', host: 'fixture-machine', machineId } });
        account.home.answer(account.serverId, `GET /v2/sessions/${session.id}`, {
            body: createPlainSessionByIdResponseFixture(session),
        });
    }
    if (scenario === 'personal send picker' || hostControls) {
        // The rendered Actions catalog reads the plugin's Account KV row,
        // separately from the legacy Todo KV below. An empty real Account
        // yields the authored default Actions through the real catalog reader.
        const { PluginAccountStorageReadResponseV1Schema } = await import('@happier-dev/protocol/plugins/data/accountKvV1');
        account.home.answer(account.serverId, `GET /v1/account/plugin-storage/${encodeURIComponent(declaration.pluginId)}`,
            { body: PluginAccountStorageReadResponseV1Schema.parse({ status: 'absent' }) });
    }
    if (sessionGithub) {
        // The Session Machine answers normally but has no GitHub contribution.
        // Account-custodied reads must not acquire a GitHub daemon Action there.
        packaged.machineRpc.mockImplementation(request => {
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { protocolVersion: 1, projection: { v: 2, generation: 1,
                    installedPackagesById: {}, actionsById: {}, familiesById: {} } };
            }
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) {
                return { status: 'sourceDeclarations', pluginId: request.payload.pluginId, sourceDeclarations: [] };
            }
            throw new Error(`Account read attempted a Machine operation: ${request.method}`);
        });
    }
    const githubHttpRequests: string[] = [];
    if (accountGithub) {
        const { QualifiedConnectedAccountProfileV4Schema, QualifiedConnectedAccountCredentialSnapshotV4Schema } = await import('@happier-dev/protocol/connect/qualified-connected-account-projections');
        const { sealQualifiedConnectedAccountContentEnvelope } = await import('@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope');
        const { PLUGIN_MANIFEST } = await import('../../../../../../../packages/plugins/scm-github/src/manifest');
        const authentication = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.find(row => row.id === GITHUB_TEST_ACCOUNT.service.localId)!.authentication;
        const connected = QualifiedConnectedAccountProfileV4Schema.parse({ ref: GITHUB_TEST_ACCOUNT,
            status: 'connected', kind: 'token', authenticationModeId: authentication.defaultModeId, revisionSemantics: 'revisioned',
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', configurationReady: true,
            configurationRevision: null, scopes: [], displayName: 'GitHub Account fixture' });
        storage.getState().applyProfile({ ...storage.getState().profile, id: lifetime.scope.accountId, connectedAccountsV4: [connected] });
        account.home.answer(account.serverId, 'GET /v4/connect/qualified/accounts', {
            body: { service: GITHUB_TEST_ACCOUNT.service, accounts: [connected] },
        });
        const payload = { v: 1, values: { token: 'synthetic-github-account-credential' } };
        const content = e2eeSecret
            ? sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee',
                material: { type: 'legacy', secret: e2eeSecret }, payload, randomBytes: length => new Uint8Array(length).fill(11) })
            : sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', payload,
                randomBytes: length => new Uint8Array(length).fill(11) });
        account.home.answer(account.serverId, 'GET /v4/connect/qualified/credential', { body: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
            ref: connected.ref, authenticationModeId: connected.authenticationModeId, revisionSemantics: connected.revisionSemantics,
            credentialRevision: connected.credentialRevision, configurationRevision: null, content,
            metadata: { displayName: connected.displayName, scopes: [] },
        }) });
        const { GITHUB_SEARCH_PULL_REQUEST_ITEM, GITHUB_PULL_REQUEST_RESPONSE, GITHUB_REPOSITORY_RESPONSE,
            GITHUB_FIXTURE_OWNER, GITHUB_FIXTURE_REPOSITORY, GITHUB_FIXTURE_REPOSITORY_ID,
            githubSearchResponse } = await import('../../../../../../../packages/plugins/scm-github/src/triage/__fixtures__/githubResponses');
        const { githubChecksBatchResponse } = await import('../../../../../../../packages/plugins/scm-github/src/triage/testkit/githubTriage.test-support');
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const repository = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase();
        const responses = new Map<string, unknown>([
            ['/user', { login: GITHUB_FIXTURE_OWNER }],
            ['/search/issues', githubSearchResponse({ items: [GITHUB_SEARCH_PULL_REQUEST_ITEM] })],
            [`/repos/${repository}`, GITHUB_REPOSITORY_RESPONSE],
            [`/repositories/${GITHUB_FIXTURE_REPOSITORY_ID}`, GITHUB_REPOSITORY_RESPONSE],
            [`/repos/${repository}/pulls/1284`, GITHUB_PULL_REQUEST_RESPONSE],
        ]);
        // Only HTTP leaves are substituted: credential acquisition and API decoding stay real.
        setRuntimeFetch(async (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            if (new URL(url).origin !== 'https://api.github.com') return account.home.request(input, init);
            const path = new URL(url).pathname;
            githubHttpRequests.push(path);
            expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-github-account-credential');
            const body = path === '/graphql' ? githubChecksBatchResponse({ url, method: 'POST',
                headers: {}, redirect: 'error', body: new TextEncoder().encode(typeof init?.body === 'string' ? init.body : '') }).body
                : responses.get(path);
            if (body === undefined) throw new Error(`Unexpected GitHub HTTP fixture path ${path}`);
            return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
    }
    if (availableMachine) {
        const github = BUNDLED_PLUGIN_UI_APP_DECLARATIONS[1]!;
        const manifest = github.presentationManifest!;
        const occurrenceId = machineOccurrenceId;
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'github-source-root' };
        const executionOrigin = { serverIdentityId: 'srv_triage_account_dispatch', sourceRef: {
            machineId, pluginId: manifest.id, sourceCustody,
        } };
        const [{ PluginProjectionV2Schema}, { RPC_METHODS}] = await Promise.all([import('@happier-dev/protocol/daemon/contributionRegistryProjection'), import('@happier-dev/protocol/rpc/methods')]);
        const { TriageScanResultV1Schema, TriageListInstancesResultV1Schema, TriageListScopeUnitsResultV1Schema } = await import('@happier-dev/triage-protocol/v1');
        const { DaemonPluginUiTargetedContributionsReadResponseSchema,
            DaemonPluginActionSchemasReadRequestSchema, DaemonPluginActionSchemasReadResponseSchema,
        } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { DaemonPluginStructuredMessageActionExecuteRequestSchema } = await import('@happier-dev/protocol/plugins/actions/daemonInvocationV1');
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [manifest.id]: { id: manifest.id, displayName: manifest.displayName,
                version: manifest.version, enabled: true, source: { kind: 'local', locator: '/plugins/scm-github' },
                occurrenceId, sourceCustody, executionOrigin, declaresContributionPoints: false } },
            // The daemon DTO is the genuine RPC boundary. The CLI projector's
            // @/ imports belong to its separate process; keep this strict wire
            // fixture to its published fields, not author-only schemas/access declarations.
            actionsById: Object.fromEntries(manifest.contributes.actions.map(action => [`${manifest.id}/${action.id}`, {
                id: action.id, title: action.title, description: action.description,
                scopes: action.scopes, surfaces: action.surfaces, execution: action.execution,
                placementBindings: action.placementBindings, dangerLevel: action.dangerLevel,
                operation: action.operation, confirmation: action.confirmation, confirmationWhen: action.confirmationWhen,
                inputHints: action.inputHints, priority: action.priority, icon: action.icon, slash: action.slash,
                pluginId: manifest.id, occurrenceId, executionOrigin, available: true,
                authorization: { generation: { targetGeneration: occurrenceId, desiredGeneration: occurrenceId, appliedGeneration: occurrenceId },
                    resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] },
            }])),
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries(Object.entries(github.entriesById)
                .map(([id, entry]) => [id, { ...entry, occurrenceId, executionOrigin }])) } },
        });
        const targeted = DaemonPluginUiTargetedContributionsReadResponseSchema.parse({ status: 'sourceDeclarations',
            pluginId: declaration.pluginId, sourceDeclarations: [{ manifest: { id: manifest.id, contributes: {
                actions: manifest.contributes.actions, pluginContributionPoints: manifest.contributes.pluginContributionPoints,
                targetedPluginContributions: manifest.contributes.targetedPluginContributions.filter(entry => entry.target.pluginId === declaration.pluginId),
                ui: { renderers: manifest.contributes.ui.renderers },
            } }, occurrenceId, sourceCustody }] });
        const { testkitSnapshot, testkitLocator, testkitViewer } = await import('../../../../../../../packages/plugins/triage/src/corpus/testkit/observations.test-support');
        const scanResult = TriageScanResultV1Schema.parse({ kind: 'complete', observations: scenario === 'Home search' ? [{
            kind: 'present', localRef: { kindId: 'pull-request', collisionScope: 'happier-dev/triage-qa-sandbox', entryId: '54' },
            locator: testkitLocator(), snapshot: testkitSnapshot({ title: 'forge-qa-failing' }), viewer: testkitViewer(),
        }] : [], evidence: { kind: 'walkFinished' } });
        packaged.machineRpc.mockImplementation(request => {
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { protocolVersion: 1, projection };
            }
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) return targeted;
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) {
                const query = DaemonPluginActionSchemasReadRequestSchema.parse(request.payload);
                expect(query.machineId).toBe(machineId);
                expect(query.expectedOccurrenceId).toBe(occurrenceId);
                const action = manifest.contributes.actions.find(row => `${manifest.id}/${row.id}` === query.qualifiedActionId);
                if (!action) throw new Error('Schema request must name a declared GitHub Action');
                return DaemonPluginActionSchemasReadResponseSchema.parse({ ok: true,
                    inputSchema: action.inputSchema, outputSchema: action.resultSchema });
            }
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                const invocation = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.payload);
                expect(invocation).toMatchObject({ machineId, expectedContributorOccurrenceId: occurrenceId });
                if (invocation.qualifiedActionId === `${manifest.id}/triage/list-github-instances-native`) {
                    expect(invocation.invocation).toMatchObject({ kind: 'clientPluginAction',
                        clientActionBinding: { pluginId: manifest.id, contributionLocalId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances } });
                    return { ok: true, result: TriageListInstancesResultV1Schema.parse({ kind: 'complete', candidates: [], failures: [] }) };
                }
                if (invocation.qualifiedActionId === `${manifest.id}/triage/list-github-scope-units-native`) {
                    return { ok: true, result: TriageListScopeUnitsResultV1Schema.parse({ kind: 'page',
                        status: 'complete', selection: { kind: 'all' }, units: [] }) };
                }
                if (invocation.qualifiedActionId === `${manifest.id}/${githubNativeReadActionId(GITHUB_TRIAGE_ACTION_IDS_V1.readSessionLinks)}`) {
                    const { sessionId } = invocation.input as { sessionId: string };
                    expect(sessionId).toBe('linked-resource-session');
                    return { ok: true, result: { kind: 'complete', links: [] } };
                }
                expect(invocation.qualifiedActionId).toBe(`${manifest.id}/triage/scan-github-native`);
                return { ok: true, result: scanResult };
            }
            throw new Error(`Unexpected Machine method ${request.method}`);
        });
    }
    const contracts = [declaration, ...(accountGithub ? [BUNDLED_PLUGIN_UI_APP_DECLARATIONS[2]!] : [])].flatMap(owner =>
        owner.presentationManifest!.contributes.accountCollections.map(contribution =>
            normalizePluginAccountCollectionContractV1({ pluginId: owner.pluginId, contribution })));
    const rows = new Map<string, ReturnType<typeof PluginCollectionRowV1Schema.parse>>();
    // Personal tasks are built in; only external connections need a persisted
    // source fixture produced through the canonical writer and wire codec.
    const corpus = createTestkitCorpusCollections();
    const personalSourceInstanceId = INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.sourceInstanceId;
    if (withGithub) {
        expect((await administerConfiguredSourceInstance({ collections: corpus.collections,
            source: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 },
            declaredPurpose: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.purpose,
            request: { kind: 'create', draft: { v: 1, binding: accountGithub
                ? { purpose: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.purpose, account: GITHUB_TEST_ACCOUNT }
                : { purpose: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.purpose, source: 'native', service: GITHUB_TEST_ACCOUNT.service }, localInstanceKey: 'github.com', keyStability: 'locatorDerived',
                configuration: { v: 1, token: encodeGithubTriageConfiguration(GITHUB_TRIAGE_ACCOUNT_SCOPE_V1)! },
                locator: { v: 1, displayLabel: 'GitHub' } } },
            nowMs: 1, mintSourceInstanceId: () => '22222222-2222-4222-8222-222222222222',
        })).kind).toBe('active');
    }
    if (sessionGithub) {
        expect((await administerConfiguredSourceInstance({ collections: corpus.collections,
            source: { pluginId: 'acme.uninstalled', localId: 'issues' },
            declaredPurpose: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.purpose,
            request: { kind: 'create', draft: { v: 1,
                binding: { purpose: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.purpose, account: GITHUB_TEST_ACCOUNT },
                localInstanceKey: 'unavailable', keyStability: 'locatorDerived',
                configuration: { v: 1, token: encodeGithubTriageConfiguration(GITHUB_TRIAGE_ACCOUNT_SCOPE_V1)! },
                locator: { v: 1, displayLabel: 'Unavailable source' } } },
            nowMs: 1, mintSourceInstanceId: () => '33333333-3333-4333-8333-333333333333',
        })).kind).toBe('active');
    }
    const persisted = await corpus.collections.sourceInstances.query({ index: 'by-lifecycle', order: 'asc' });
    const sourceContract = contracts.find(contract => contract.collectionId === 'source-instances')!;
    const validate = compilePluginJsonSchema(sourceContract.schema);
    for (const row of persisted.rows) {
        const encoded = encodePluginCollectionLogicalValueV1({ contract: sourceContract, value: row.value,
            isValidLogicalValue: value => isValidPluginJsonSchemaValue(validate, value), encryptionMode: e2eeSecret ? 'e2ee' : 'plain',
            material: e2eeSecret ? { type: 'legacy', secret: e2eeSecret } : null,
            randomBytes: length => new Uint8Array(length) });
        if (encoded.status !== 'encoded') throw new Error(`Invalid produced source fixture: ${encoded.reason}`);
        rows.set(encoded.rowId, PluginCollectionRowV1Schema.parse({ rowId: encoded.rowId, content: encoded.content,
            projection: encoded.projection, revision: row.revision }));
    }
    const channelsRows = new Map<string, ReturnType<typeof PluginCollectionRowV1Schema.parse>>();
    if (accountGithub) {
        const { createCurrentConversationConnectionFixture } = await import('../../../../../../../packages/plugins/channels/src/testkit/currentConnectionFixture');
        const { withChannelStateSessionIdentity } = await import('../../../../../../../packages/plugins/channels/src/collectionMigrations');
        const { GITHUB_FIXTURE_OWNER, GITHUB_FIXTURE_REPOSITORY, GITHUB_FIXTURE_REPOSITORY_ID } = await import('../../../../../../../packages/plugins/scm-github/src/triage/__fixtures__/githubResponses');
        const repository = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase();
        const connection = createCurrentConversationConnectionFixture({ connectionId: 'retained-native-connection', authority: {
            providerPluginId: GITHUB_PLUGIN_ID, providerContributionSelection: { contributionId: 'github' },
            providerSetupInput: { repository, credentialRef: null }, credentialRef: null,
            transportOrigin: { serverIdentityId: 'srv_triage_account_dispatch', machineId: 'original-native-machine' },
            providerConnectionKey: `github:repository:${GITHUB_FIXTURE_REPOSITORY_ID}`, providerConfig: { v: 1,
                repository: { v: 1, repositoryId: GITHUB_FIXTURE_REPOSITORY_ID, owner: GITHUB_FIXTURE_OWNER,
                    name: GITHUB_FIXTURE_REPOSITORY, nameWithOwner: repository }, integrationPrincipal: { id: '99' } },
            routingIdentityKey: 'f'.repeat(43), integrationPrincipal: { id: '99' }, authorityEpoch: 1,
        } });
        const target = { kind: 'session', sessionId: 'linked-resource-session', pullRequestLink: { repository, number: 1284 },
            policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } };
        const binding = withChannelStateSessionIdentity({ id: 'retained-pr-binding', 'record-kind': 'binding', v: 1,
            'connection-id': connection.id, 'binding-id': 'retained-pr-binding', 'created-at': 42, 'updated-at': 42,
            payload: { endpoint: { kind: 'githubPullRequest', audience: 'shared',
                id: `github:repository:${GITHUB_FIXTURE_REPOSITORY_ID}:issue:1284:number:1284`, parentId: GITHUB_FIXTURE_REPOSITORY_ID,
                pullRequest: { repository, number: 1284 } }, target, allowedPrincipalIds: ['99'], allowBotSenders: false,
                inputMode: 'allAllowedMessages', inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off',
                authorityEpoch: 1, enabled: false, deletionState: 'none' } }, target);
        const contract = contracts.find(contract => contract.pluginId === 'happier.channels')!;
        const valid = compilePluginJsonSchema(contract.schema);
        for (const value of [connection, binding]) {
            const encoded = encodePluginCollectionLogicalValueV1({ contract, value,
                isValidLogicalValue: value => isValidPluginJsonSchemaValue(valid, value),
                encryptionMode: e2eeSecret ? 'e2ee' : 'plain', material: e2eeSecret ? { type: 'legacy', secret: e2eeSecret } : null,
                randomBytes: length => new Uint8Array(length) });
            if (encoded.status !== 'encoded') throw new Error(`Invalid Channels fixture: ${encoded.reason}`);
            channelsRows.set(encoded.rowId, PluginCollectionRowV1Schema.parse({ rowId: encoded.rowId,
                content: encoded.content, projection: encoded.projection, revision: 1 }));
        }
    }
    const todoRows = new Map([
        { key: 'todo.index', version: 1, value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { undoneOrder: ['personal-task'], completedOrder: [] } }) },
        { key: 'todo.personal-task', version: 1, value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: {
            id: 'personal-task', title: 'Account personal task', notes: 'Native task notes from Account', done: false, createdAt: 1, updatedAt: 1 } }) },
    ].map(row => [row.key, row]));
    // Task Resources project these same Account KV rows. Seeding only the old
    // KV endpoint leaves the supported /v1/tasks reader with an empty inventory.
    const taskResource = (key: string) => {
        const row = todoRows.get(key);
        if (!row) return null;
        return TaskResourceV1Schema.parse({ ownerAccountId: lifetime.scope.accountId, taskId: key.slice(5),
            version: row.version, content: decodeBase64StoredJsonContentEnvelope(row.value),
            access: 'owner', encryptionMode: 'plain', encryptedDataKey: null });
    };
    const publishTodoRow = (key: string) => {
        account.home.answer(account.serverId, `GET /v1/kv/${key}`, {
            select: () => todoRows.has(key) ? { body: todoRows.get(key) } : { status: 404 },
        });
        if (key !== 'todo.index') account.home.answer(account.serverId,
            `GET /v1/tasks/${encodeURIComponent(lifetime.scope.accountId)}/${encodeURIComponent(key.slice(5))}`, {
                select: () => todoRows.has(key) ? { body: taskResource(key) } : { status: 404, body: { error: 'task_not_found' } },
            });
    };
    account.home.answer(account.serverId, 'GET /v1/tasks', { select: () => ({ body: TaskResourcesListResponseV1Schema.parse({
        tasks: [...todoRows.keys()].filter(key => key !== 'todo.index').map(taskResource),
    }) }) });
    account.home.answer(account.serverId, 'GET /v1/kv', { select: (_body, request) => {
        const prefix = new URL(request.url).searchParams.get('prefix') ?? '';
        return { body: { items: [...todoRows.values()].filter(row => row.key.startsWith(prefix)) } };
    } });
    account.home.answer(account.serverId, 'POST /v1/kv/bulk', { select: input => {
        const { keys } = z.object({ keys: z.array(z.string()) }).parse(input);
        return { body: { values: keys.flatMap(key => {
            const row = todoRows.get(key);
            return row ? [row] : [];
        }) } };
    } });
    for (const row of todoRows.values()) publishTodoRow(row.key);
    account.home.answer(account.serverId, 'POST /v1/kv', { select: value => {
        const { mutations } = kvMutationsSchema.parse(value);
        const conflicts = mutations.filter(row => row.version !== (todoRows.get(row.key)?.version ?? -1));
        if (conflicts.length) return { status: 409, body: { success: false, errors: conflicts.map(row => ({
            key: row.key, error: 'version-mismatch', version: todoRows.get(row.key)?.version ?? -1,
            value: todoRows.get(row.key)?.value ?? null,
        })) } };
        const results = mutations.map(row => {
            const version = row.version + 1;
            if (row.value === null) todoRows.delete(row.key);
            else todoRows.set(row.key, { key: row.key, value: row.value, version });
            publishTodoRow(row.key);
            return { key: row.key, version };
        });
        return { body: { success: true, results } };
    } });
    account.home.answer(account.serverId, 'POST /v1/plugins/data/contract', { select: value => {
        const { ref } = PluginCollectionContractReadRequestV1Schema.parse(value);
        const contract = contracts.find(contract => contract.pluginId === ref.pluginId && contract.collectionId === ref.collectionId);
        if (!contract) throw new Error('Unexpected Triage Collection');
        return { body: { access: contract.pluginId === declaration.pluginId ? 'writable' : 'readOnly', contract } };
    } });
    account.home.answer(account.serverId, 'POST /v1/plugins/data/get', { select: value => {
        const request = PluginCollectionGetRequestV1Schema.parse(value);
        return { body: { row: (request.pluginId === 'happier.channels' ? channelsRows : rows).get(request.rowId) ?? null, absenceEpoch: 0 } };
    } });
    let refuseChannelsCollectionRead = false;
    let channelsCollectionRead = false;
    account.home.answer(account.serverId, 'POST /v1/plugins/data/query', { select: value => {
        const request = PluginCollectionQueryRequestV1Schema.parse(value);
        if (request.pluginId === 'happier.channels') channelsCollectionRead = true;
        if (refuseChannelsCollectionRead && request.pluginId === 'happier.channels') {
            return { status: 503, body: { error: 'collection_unavailable' } };
        }
        const index = contracts.find(contract => contract.pluginId === request.pluginId && contract.collectionId === request.collectionId)?.indexes.find(index => index.id === request.indexId);
        if (!index) throw new Error('Unexpected Triage Collection index');
        // Only source-instances is seeded. A whole-Collection relationship read
        // has no prefix and must observe its own empty Collection.
        const candidates = request.pluginId === 'happier.channels' ? [...channelsRows.values()]
            : request.collectionId === sourceContract.collectionId ? [...rows.values()] : [];
        return { body: { rows: candidates.filter(row => (request.prefix ?? []).every((part, position) =>
            row.projection[index.fields[position]!.field] === part)), changeCursor: 1 } };
    } });
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope,
        snapshot: { availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId: declaration.pluginId,
            response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
                hostingCapability: { enabled: false }, intent: { pluginId: declaration.pluginId, desiredVersion: null,
                    enabled: true, offlineUiHosting: 'disabled', writableCollections: declaration.collectionContracts, revision: 'claimed' },
                release: null, packageAssets: [], uiArtifacts: [] }) }, { pluginId: GITHUB_PLUGIN_ID,
            response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
                hostingCapability: { enabled: false }, intent: { pluginId: GITHUB_PLUGIN_ID, desiredVersion: null,
                    enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'github-catalog' },
                release: null, packageAssets: [], uiArtifacts: [] }) }, ...(accountGithub ? [{ pluginId: 'happier.channels',
            response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
                hostingCapability: { enabled: false }, intent: { pluginId: 'happier.channels', desiredVersion: null,
                    enabled: true, offlineUiHosting: 'disabled', writableCollections: BUNDLED_PLUGIN_UI_APP_DECLARATIONS[2]!.collectionContracts, revision: 'channels-catalog' },
                release: null, packageAssets: [], uiArtifacts: [] }) }] : [])] } });
    // Only the direct-dispatch cases explicitly demand a declaration. The
    // physical page must activate its own cold lazy declaration and detail.
    if (!personalDetail) {
        await readPluginAccountAvailability(lifetime.scope).ensureCurrentAccountExecution(declaration.pluginId);
        if (withGithub) await readPluginAccountAvailability(lifetime.scope).ensureCurrentAccountExecution(GITHUB_PLUGIN_ID);
        if (accountGithub) await readPluginAccountAvailability(lifetime.scope).ensureCurrentAccountExecution('happier.channels');
    }
    const { buildTriageRouteSubPathV1, TRIAGE_ROUTE_DEFAULT_LENS_V1 } = await import('../../../../../../../packages/plugins/triage/src/ui/navigation/location');
    const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
    let setPageInputFocus: React.Dispatch<React.SetStateAction<boolean>> | undefined;
    function PhysicalPageScene() {
        const [focused, setFocused] = React.useState(true);
        setPageInputFocus = setFocused;
        const page = <PluginAppPageScreen pluginId={declaration.pluginId} localId="tasks"
            subPath={buildTriageRouteSubPathV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
                selection: { source: INTERNAL_TASK_SOURCE_V1, ...internalTaskLocalRefV1('personal-task') } })} />;
        return <PluginSurfaceFocusEligibilityProvider active={focused} presentationActive currentUiContextActive>
            {hostControls ? page : <AppShellPluginUiProjectionProvider>{page}</AppShellPluginUiProjectionProvider>}
        </PluginSurfaceFocusEligibilityProvider>;
    }
    const screen = personalDetail || scenario === 'client mounted E2EE'
        ? await renderMountedCurrentUiContext(<PhysicalPageScene />, { withAppShellActions: hostControls })
        : await renderWithAppProviders(<AppShellPluginUiProjectionProvider><></></AppShellPluginUiProjectionProvider>);
    try {
        if (personalDetail && !hostControls) {
            const { PluginReactNativeSurface } = await import('@/components/plugins/reactNative/PluginReactNativeSurface');
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                const embedded = screen.tree.root.findAllByType(PluginReactNativeSurface).filter(node =>
                    node.props.renderContext.surface.mount?.kind === 'embedded');
                expect(embedded, JSON.stringify(screen.tree.toJSON())).toHaveLength(1);
                expect(embedded[0]!.findAll(node => node.props.children === 'Native task notes from Account').length).toBeGreaterThan(0);
            });
        }
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            const action = readCurrentAppShellPluginUiProjection()?.actionsById['happier.triage/sources/read-configured-v1'];
            expect(action && resolvePluginUiClientActionRegistration({ action, platform: hostControls ? 'ios' : 'web' })).not.toBeNull();
        });
        if (hostControls) return {
            dispose: () => screen.unmount(),
            run: async () => {
                const { pressTestInstanceAsync, findTestInstanceByTypeContainingText } = await import('@/dev/testkit');
                const completion = () => findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Done');
                const inlineControl = () => screen.tree.root.findAll(node => typeof node.type === 'string'
                    && typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.startsWith('Change status')
                    && typeof node.props.onPress === 'function' && node.props.disabled !== true).at(-1);
                await waitForHomeGovernance(async () => {
                    await flushHookEffects();
                    expect(inlineControl(), screen.getTextContent()).toBeDefined();
                });
                await pressTestInstanceAsync(inlineControl(), 'inline task status menu');
                await waitForHomeGovernance(async () => {
                    await flushHookEffects();
                    expect(completion()).toBeDefined();
                });
                await pressTestInstanceAsync(completion(), 'inline task completion');
                await waitForHomeGovernance(async () => {
                    await flushHookEffects();
                    const completed = [...todoRows.keys()].filter(key => key !== 'todo.index'
                        && z.object({ t: z.literal('plain'), v: z.object({ done: z.boolean() }) }).parse(taskResource(key)?.content).v.done);
                    expect(completed, JSON.stringify({
                        page: screen.getTextContent(),
                        requests: account.home.requests.slice(-16).map(request => ({ method: request.method, path: request.path })),
                    })).toHaveLength(1);
                });
                expect([...todoRows.keys()].filter(key => key !== 'todo.index')).toHaveLength(1);
                expect(packaged.machineRpc).not.toHaveBeenCalled();
            },
        };
        const accountProjection = readCurrentAppShellPluginUiProjection()!;
        const { loadDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        const { mergeInstalledPluginUiProjections } = await import('@/sync/domains/plugins/ui/projectionUnion');
        const machineInputs = availableMachine ? await loadDaemonMergedProjectionInputs({ sections: 'complete', machineId,
            serverId: lifetime.scope.serverId, accountLifetime: lifetime }) : null;
        if (availableMachine) expect(machineInputs, 'the selected Machine must publish its real Action projection').not.toBeNull();
        // A mounted Host combines Account custody with its selected Machine's
        // Action declarations; the Account-only shell catalog has no daemon Actions.
        const projection = mergeInstalledPluginUiProjections([accountProjection], machineInputs?.pluginUiProjection ?? null)!;
        // These scenarios assert search results and native scan counts. Prepare
        // their real executable in the hook; personal detail retains the cold
        // physical-page activation path without explicit preparation.
        if (scenario === 'personal search' || scenario === 'Home search') {
            const registration = resolvePluginUiClientActionRegistration({
                action: projection.actionsById['happier.triage/entries/list-v1']!, platform: 'web',
            });
            expect(registration).not.toBeNull();
            await registration!.registration.prepare?.();
        }
        const action = projection.actionsById['happier.triage/sources/read-configured-v1']!;
        const origin = readPluginUiAccountExecutableOrigin(action)!;
        const openedSurfaces: unknown[] = [];
        const controller = createBoundPluginSurfaceController({ facts: {
            pluginId: 'happier.triage', contributionId: 'tasks', surfaceId: 'surfacePlacement:happier.triage:tasks',
            placement: 'browserSurface', platform: 'web', channel: 'internal', serverId: lifetime.scope.serverId,
            machineId: withMachine ? machineId : null,
            ...(sessionGithub ? { sessionId: 'linked-resource-session' } : {}),
            accountLifetime: lifetime, occurrenceId: origin.custodyId, accountExecutionOrigin: origin,
            // Account caller custody and the selected Machine supplier lease are separate facts.
            ...(availableMachine ? { daemonOccurrenceId: machineOccurrenceId } : {}),
            pluginUiProjection: projection,
            // A source-mounted snapshot can omit the callee that Account publication owns.
            resolveContributedAction: identity => scenario === 'client mounted E2EE'
                || sessionGithub && identity.pluginId !== declaration.pluginId ? null : createPluginUiProjectedActionResolver(
                projection.actionsById,
            )(identity),
            interactionEnabled: true, daemonInteractionEnabled: availableMachine,
        }, binding: { executeHostAction: scopedHomeActionExecutor(lifetime.scope),
            openSurface: async request => { openedSurfaces.push(request); return { ok: true }; },
        } });
        const dispatch = controller.dispatchAction;
        return {
            dispose: async () => { controller.dispose(); await screen.unmount(); },
            run: async () => {
        if (scenario === 'personal send picker') {
            const { pressTestInstanceAsync } = await import('@/dev/testkit');
            const { TranscriptSendToSessionModal } = await import('@/components/sessions/transcript/messageSelection/TranscriptSendToSessionModal');
            const byLabel = (label: string) => screen.tree.root.findAll(node => typeof node.type === 'string'
                && node.props.accessibilityLabel === label && typeof node.props.onPress === 'function').at(-1);
            const labels = () => screen.tree.root.findAll(node => typeof node.type === 'string'
                && typeof node.props.onPress === 'function').map(node => node.props.accessibilityLabel).filter(Boolean);
            let options: import('react-test-renderer').ReactTestInstance | undefined;
            let send: import('react-test-renderer').ReactTestInstance | undefined;
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                send = byLabel('Send to a Session…');
                options = byLabel('Start options');
                expect(send ?? options, JSON.stringify(labels())).toBeDefined();
            });
            if (!send) {
                await pressTestInstanceAsync(options, 'Start options');
                await waitForHomeGovernance(async () => {
                    await flushHookEffects();
                    send = byLabel('Send to a Session…');
                    expect(send, JSON.stringify(labels())).toBeDefined();
                });
            }
            vi.mocked(Modal.show).mockClear();
            const pressing = pressTestInstanceAsync(send, 'Send to a Session…');
            try {
                await vi.waitFor(() => expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
                    component: TranscriptSendToSessionModal,
                    props: expect.objectContaining({ selectionOnly: true, sourceServerId: lifetime.scope.serverId }),
                })));
            } finally {
                const picker = vi.mocked(Modal.show).mock.calls.find(([request]) => request.component === TranscriptSendToSessionModal)?.[0];
                await act(async () => { picker?.onRequestClose?.(); });
                await pressing;
            }
            expect(packaged.machineRpc).not.toHaveBeenCalled();
            return;
        }
        if (scenario === 'client mounted E2EE') {
            const { TRIAGE_TASKS_OPEN_CREATE_ACTION_LOCAL_ID_V1 } = await import('../../../../../../../packages/plugins/triage/src/actions/tasksProtocol');
            const { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 } = await import('../../../../../../../packages/plugins/triage/src/actions/mountedUiProtocol');
            const { resolveCurrentContributedAction } = await import('@/components/appShell/currentUiContext/contributedActionInvocation');
            const readProjection = () => readCurrentAppShellPluginUiProjection({ scope: lifetime.scope, declarationsOnly: true });
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                for (const localId of [TRIAGE_TASKS_OPEN_CREATE_ACTION_LOCAL_ID_V1, TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1]) {
                    expect(resolveCurrentContributedAction(readProjection, { pluginId: declaration.pluginId, localId }),
                        'Account client Actions must be executable without a Machine').not.toBeNull();
                }
            });
            const result = await controller.hostApi.handleRequest({ version: 1, requestId: 'account-client-open-create',
                surface: controller.surfaceContext, method: 'executeAction',
                payload: { action: { pluginId: declaration.pluginId, localId: TRIAGE_TASKS_OPEN_CREATE_ACTION_LOCAL_ID_V1 },
                    input: { title: 'A draft without a Machine' } } });
            expect(result, JSON.stringify(result)).toEqual({ status: 'applied' });
            expect(openedSurfaces).toEqual([expect.objectContaining({ destination: { pluginId: declaration.pluginId,
                localId: 'tasks' }, input: expect.objectContaining({ kind: 'createTask', draftId: expect.any(String) }) })]);
            const { executeCurrentUiContextAction } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
            const read = await executeCurrentUiContextAction({ actionId: 'ui.current_context.read', input: {}, context: { surface: 'agent' } });
            if (!read.ok) throw new Error('Expected the actual Triage page context');
            const address = z.object({ detail: z.object({ mountedAction: z.object({ mountId: z.string() }) }) }).parse(read.result);
            await act(async () => { setPageInputFocus!(false); });
            await flushHookEffects();
            const selectView = await controller.hostApi.handleRequest({ version: 1, requestId: 'account-client-covered-select-view',
                surface: controller.surfaceContext, method: 'executeAction',
                payload: { action: { pluginId: declaration.pluginId, localId: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 },
                    input: { mountId: address.detail.mountedAction.mountId, operation: { kind: 'selectSavedView', viewId: null } } } });
            expect(selectView, 'a presented page keeps its actual mounted callback while its overlay takes input').toEqual({ status: 'applied' });
            await act(async () => { setPageInputFocus!(true); });
            const { bindTriageMountedUiActions, bindTriageMountedSourcePanelAction } = await import('../../../../../../../packages/plugins/triage/src/ui/mountedActions');
            const { PluginReactNativeSurface } = await import('@/components/plugins/reactNative/PluginReactNativeSurface');
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(screen.tree.root.findAll(node => typeof node.type === 'function'
                    && node.type.name === 'PluginReactNativeSurfaceHost'
                    && node.props.canonicalRenderIdentity.pluginId === declaration.pluginId).length).toBeGreaterThan(0);
            });
            const rendererHost = screen.tree.root.findAll(node => typeof node.type === 'function'
                && node.type.name === 'PluginReactNativeSurfaceHost'
                && node.props.canonicalRenderIdentity.pluginId === declaration.pluginId)[0]!;
            // Exercise the physical renderer's private binding producer with the live
            // Account-custody/Machine-placement combination, not a matching scope fixture.
            const placedRenderer = await renderWithAppProviders(React.createElement(
                rendererHost.type as React.ComponentType<Readonly<Record<string, unknown>>>, {
                    ...rendererHost.props,
                    canonicalRenderIdentity: { ...rendererHost.props.canonicalRenderIdentity,
                        executionOrigin: { serverIdentityId: 'srv_triage_account_dispatch', sourceRef: {
                            machineId, pluginId: declaration.pluginId,
                            sourceCustody: { kind: 'development', registeredRootId: 'triage-renderer-placement' },
                        } },
                    },
                }));
            await flushHookEffects();
            const mountedScope = placedRenderer.tree.root.findAllByType(PluginReactNativeSurface)[0]!
                .props.privateHostBindings.ephemeralSharedScope;
            if (!mountedScope) throw new Error('Expected the current Account-mounted scope');
            let selectedOccurrence = 'first-occurrence';
            const releaseMounted = bindTriageMountedUiActions(mountedScope, 'account-source-panel', async () => ({ status: 'unavailable' }));
            const releaseSource = bindTriageMountedSourcePanelAction(mountedScope, 'account-source-panel', 'selectSourceOccurrence', async operation => {
                if (operation.kind !== 'selectSourceOccurrence') return { status: 'unavailable' };
                selectedOccurrence = operation.occurrenceId;
                return { status: 'applied' };
            });
            const selectOccurrence = () => controller.hostApi.handleRequest({ version: 1, requestId: 'account-client-source-select',
                surface: controller.surfaceContext, method: 'executeAction',
                payload: { action: { pluginId: declaration.pluginId, localId: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 },
                    input: { mountId: 'account-source-panel', operation: { kind: 'selectSourceOccurrence', occurrenceId: 'second-occurrence' } } } });
            try {
                expect(await selectOccurrence()).toEqual({ status: 'applied' });
                expect(selectedOccurrence).toBe('second-occurrence');
            } finally { releaseSource(); releaseMounted(); await placedRenderer.unmount(); }
            expect(await selectOccurrence()).toEqual({ status: 'unavailable' });
            expect(packaged.machineRpc).not.toHaveBeenCalled();
            return;
        }
        if (accountGithub) {
            const { TriageListEntriesResultV1Schema } = await import('../../../../../../../packages/plugins/triage/src/actions/listEntriesProtocol');
            const { readTriageEntryDetailState } = await import('../../../../../../../packages/plugins/triage/src/ui/detail/useTriageEntryDetail');
            const { createCanonicalPluginReactNativeHostApiAdapter } = await import('@/components/plugins/reactNative/hostApi');
            const { createPluginSurfaceContextFixture } = await import('@/dev/testkit/fixtures/pluginSurfaceContextFixture');
            let actionRequestId: string | undefined;
            const adapter = createCanonicalPluginReactNativeHostApiAdapter({
                surface: createPluginSurfaceContextFixture({ accountEncryptionMode: e2eeSecret ? 'e2ee' : 'plain' }),
                requestSurface: controller.surfaceContext,
                installedMethods: controller.hostApi.installedMethods,
                handleRequest: (request, options) => {
                    if (request.method === 'executeAction') actionRequestId = request.requestId;
                    return controller.hostApi.handleRequest(request, options);
                },
            });
            try {
            const host = adapter.api;
            if (sessionGithub) {
                const { createPluginDeclaredResourceStore } = await import('@/components/plugins/surfaces/PluginContextualResourceStoreProvider');
                const { TriageReadSourceSessionLinksResultV1Schema } = await import('../../../../../../../packages/plugins/triage/src/actions/sessionLinksProtocol');
                const store = createPluginDeclaredResourceStore({ accountLifetime: lifetime, pluginId: declaration.pluginId,
                    machineId, serverId: lifetime.scope.serverId, expectedCallerOccurrenceId: origin.custodyId,
                    resourcesById: projection.resourcesById, resourceDeclarationsComplete: true, sessionId: 'linked-resource-session' });
                if (!store) throw new Error('Expected the declared Session Resource store');
                try {
                    const snapshot = await store.getEntry('session-links-v1').refresh();
                    expect(snapshot.error).toBeUndefined();
                    const linked = TriageReadSourceSessionLinksResultV1Schema.parse(JSON.parse(new TextDecoder().decode(snapshot.value!.bytes)));
                    expect(linked.links).toEqual([expect.objectContaining({ sessionId: 'linked-resource-session', entryRef: expect.objectContaining({ entryId: '1284' }) })]);
                    expect(linked.lanes).toEqual(expect.arrayContaining([expect.objectContaining({ displayLabel: 'Unavailable source',
                        health: expect.objectContaining({ kind: 'failed', invocationError: {
                            code: 'sessionLinksSourceNotAdmitted', requestId: expect.any(String),
                        } }),
                    })]));
                    expect(linked.lanes?.filter(lane => lane.source.pluginId === GITHUB_PLUGIN_ID), JSON.stringify(linked))
                        .toEqual(expect.arrayContaining([expect.objectContaining({ kindIds: ['pull-request'], health: { kind: 'complete' } })]));
                } finally { store.dispose(); }
            }
            const listed = await host.executeAction('entries/list-v1', { v: 1, sources: { kind: 'allConfigured' },
                query: 'terminal', limit: 32, order: 'smart' });
            const result = TriageListEntriesResultV1Schema.parse(listed);
            const row = result.window.rows.find(row => row.entryRef.entryId === '1284');
            expect(row, JSON.stringify({ listed, githubHttpRequests, homeReads: account.home.requests.map(request => request.path) })).toBeDefined();
            if (!row || row.observation.outcome.kind !== 'present') throw new Error('Expected the GitHub scan result');
            expect(githubHttpRequests).toContain('/search/issues');
            const configured = await corpus.collections.sourceInstances.query({ index: 'by-lifecycle', order: 'asc' });
            const instance = configured.rows.find(row => row.value.configured.instance.source.pluginId === GITHUB_PLUGIN_ID)!.value.configured;
            const { TriageGetResultV1Schema } = await import('@happier-dev/triage-protocol/v1');
            // Open refreshes the exact source through its compiled Account Action.
            const get = TriageGetResultV1Schema.parse(await host.executeAction({ pluginId: GITHUB_PLUGIN_ID,
                localId: GITHUB_TRIAGE_ACTION_IDS_V1.get }, { v: 1, instance,
                localRef: { kindId: row.entryRef.kindId, collisionScope: row.entryRef.collisionScope, entryId: row.entryRef.entryId } }));
            expect(get.kind, JSON.stringify(get)).toBe('present');
            const outcome = row.observation.outcome;
            const source = {
                selection: { entryRef: row.entryRef, sourceInstanceId: row.observation.sourceInstanceId },
                observation: { entryRef: row.entryRef, observedAtMs: row.observation.observedAtMs,
                    locator: outcome.locator, snapshot: outcome.snapshot, viewer: outcome.viewer },
            };
            const detail = await readTriageEntryDetailState(host, source);
            expect(detail, JSON.stringify(detail)).toMatchObject({ kind: 'ready', input: {
                instance: { binding: { account: GITHUB_TEST_ACCOUNT } },
                observation: { snapshot: { title: 'Stream terminal frames without a full re-render' } },
            }, linkedSessions: [{ sessionId: 'linked-resource-session' }] });
            expect(channelsCollectionRead, 'linked Sessions must come from the canonical Channels Collection').toBe(true);
            // A real Collection refusal follows the same physical host settlement
            // as the successful read, preserving the generated Request ID.
            refuseChannelsCollectionRead = true;
            if (sessionGithub) {
                const { createPluginDeclaredResourceStore } = await import('@/components/plugins/surfaces/PluginContextualResourceStoreProvider');
                const { TriageReadSourceSessionLinksResultV1Schema } = await import('../../../../../../../packages/plugins/triage/src/actions/sessionLinksProtocol');
                const store = createPluginDeclaredResourceStore({ accountLifetime: lifetime, pluginId: declaration.pluginId,
                    machineId, serverId: lifetime.scope.serverId, expectedCallerOccurrenceId: origin.custodyId,
                    resourcesById: projection.resourcesById, resourceDeclarationsComplete: true, sessionId: 'linked-resource-session' });
                if (!store) throw new Error('Expected the declared Session Resource store');
                try {
                    const snapshot = await store.getEntry('session-links-v1').refresh();
                    expect(snapshot.error).toBeUndefined();
                    const partial = TriageReadSourceSessionLinksResultV1Schema.parse(JSON.parse(new TextDecoder().decode(snapshot.value!.bytes)));
                    const failure = partial.lanes?.find(lane => lane.source.pluginId === GITHUB_PLUGIN_ID && lane.kindIds?.includes('pull-request'))?.health;
                    expect(failure).toMatchObject({ kind: 'failed', invocationError: { requestId: expect.any(String) } });
                } finally { store.dispose(); }
            }
            const refused = await readTriageEntryDetailState(host, source);
            expect(refused).toMatchObject({ kind: 'unreachable', failure: {
                code: 'unavailable', details: { requestId: actionRequestId },
            } });
            expect(actionRequestId).toEqual(expect.any(String));
            expect(actionRequestId).not.toBe('');
            if (sessionGithub) expect(packaged.machineRpc.mock.calls.filter(([request]) =>
                request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)).toHaveLength(0);
            else expect(packaged.machineRpc).not.toHaveBeenCalled();
            return;
            } finally { adapter.dispose(); }
        }
        if (scenario === 'Home search') {
            const { buildPluginSearchProviderSections } = await import('@/components/appShell/search/pluginSearchProviderSections');
            const sections = buildPluginSearchProviderSections({ projection,
                scopedLaunchFacts: { serverId: lifetime.scope.serverId, machineId: null, interactionEnabled: true },
                homeMachines: [{ machineId, name: 'GitHub Machine', reachable: true }, { machineId: 'offline-source', name: 'Offline source', reachable: false }],
                accountLifetime: lifetime, onCommitActivation: () => undefined });
            const section = sections.find(section => section.id === 'plugin-search:happier.triage:entry-search');
            expect(section).toBeDefined();
            const result = await section!.resolve('forge-qa-failing', new AbortController().signal);
            expect(result.options.map(option => option.label)).toEqual(['forge-qa-failing']);
            expect(result.resultHint).toContain('Offline source');
            const scans = packaged.machineRpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE
                && request.payload.qualifiedActionId === `${GITHUB_PLUGIN_ID}/${githubNativeReadActionId(GITHUB_TRIAGE_ACTION_IDS_V1.scan)}`);
            expect(scans).toHaveLength(1);
            expect(scans[0]?.[0].payload.input).toMatchObject({ query: 'forge-qa-failing' });
            const machineSection = buildPluginSearchProviderSections({ projection,
                scopedLaunchFacts: { serverId: lifetime.scope.serverId, machineId, interactionEnabled: true },
                homeMachines: [{ machineId: 'outside-explicit-scope', name: 'Other Machine', reachable: true }],
                accountLifetime: lifetime, onCommitActivation: () => undefined })
                .find(section => section.id === 'plugin-search:happier.triage:entry-search')!;
            expect((await machineSection.resolve('forge-qa-failing', new AbortController().signal)).options.map(option => option.label))
                .toEqual(['forge-qa-failing']);
            const offlineSection = buildPluginSearchProviderSections({ projection,
                scopedLaunchFacts: { serverId: lifetime.scope.serverId, machineId: null, interactionEnabled: true },
                homeMachines: [{ machineId, name: 'Offline source', reachable: false }],
                accountLifetime: lifetime, onCommitActivation: () => undefined })
                .find(section => section.id === 'plugin-search:happier.triage:entry-search')!;
            const offlineResult = await offlineSection.resolve('Account personal', new AbortController().signal);
            expect(offlineResult.options.map(option => option.label)).toEqual(['Account personal task']);
            expect(offlineResult.resultHint).toContain('Offline source');
            expect(packaged.machineRpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE
                && request.payload.qualifiedActionId === `${GITHUB_PLUGIN_ID}/${githubNativeReadActionId(GITHUB_TRIAGE_ACTION_IDS_V1.scan)}`)).toHaveLength(2);
            return;
        }
        if (scenario === 'personal search') {
            // Reproduce This Home through the portable Account artifact, with
            // no Machine description, client search wrapper or supplied executor.
            expect(Object.values(projection.searchProvidersById).find(provider =>
                provider.pluginId === declaration.pluginId && provider.descriptorId === 'entry-search'),
            'providerProjected=false: Account-owned Triage search must not depend on a Machine description').toBeDefined();
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                const queryAction = readCurrentAppShellPluginUiProjection()?.actionsById['happier.triage/entries/search-v1'];
                expect(queryAction?.execution.target).toBe('account');
                expect(queryAction && resolvePluginUiClientActionRegistration({ action: queryAction, platform: 'web' })).not.toBeNull();
            });
            // Positive control through the incumbent scoped surface dispatcher:
            // distinguish corpus/matcher errors from the palette's default binding.
            const listed = await dispatch('entries/list-v1', { v: 1, sources: { kind: 'allConfigured' },
                query: 'Account personal', limit: 32, order: 'smart' });
            expect(listed, JSON.stringify(listed)).toMatchObject({ window: { rows: [expect.objectContaining({
                entryRef: expect.objectContaining({ entryId: 'personal-task' }),
            })] } });
            const searched = await dispatch('entries/search-v1', { query: 'Account personal', limit: 32 });
            expect(searched, JSON.stringify(searched)).toMatchObject({
                items: [expect.objectContaining({ title: 'Account personal task' })],
            });
            const { buildPluginSearchProviderSections } = await import('@/components/appShell/search/pluginSearchProviderSections');
            const currentProjection = mergeInstalledPluginUiProjections([readCurrentAppShellPluginUiProjection()!], null)!;
            const sections = buildPluginSearchProviderSections({ projection: currentProjection,
                scopedLaunchFacts: { serverId: lifetime.scope.serverId, machineId: null, interactionEnabled: true },
                accountLifetime: lifetime, onCommitActivation: () => undefined });
            const section = sections.find(section => section.id === 'plugin-search:happier.triage:entry-search');
            expect(section, 'This Home must offer the admitted Triage section without any Machine').toBeDefined();
            if (!section) throw new Error('Triage search section was not offered');
            const result = await section.resolve('Account personal', new AbortController().signal);
            // A complete negative result must not be confused with a query
            // discarded by the palette's Account-retirement boundary.
            expect(lifetime.isCurrent(), 'the query must retain its admitting Account lifetime').toBe(true);
            const { resolvePluginUiExecutionDeclaration } = await import('@/sync/domains/plugins/ui/projectionUnion');
            const currentDeclarations = readCurrentAppShellPluginUiProjection({ scope: lifetime.scope, declarationsOnly: true });
            expect(resolvePluginUiExecutionDeclaration(currentProjection.actionsById['happier.triage/entries/search-v1']!, {
                current: currentDeclarations?.actionsById['happier.triage/entries/search-v1'],
            }), 'the query Action must not retire before its rows are consumed').not.toBeNull();
            expect(result.options, JSON.stringify({ result, accountCurrent: lifetime.isCurrent(),
                homeReads: account.home.requests.map(request => request.path) })).toEqual(expect.arrayContaining([
                expect.objectContaining({ label: 'Account personal task', id: expect.stringContaining('plugin-search:happier.triage:entry-search::') }),
            ]));
            expect(packaged.machineRpc).not.toHaveBeenCalled();
            return;
        }
            if (scenario !== 'personal CRUD') {
                expect(await dispatch('sources/read-configured-v1', { v: 1 })).toMatchObject({ kind: 'read', instances: [{ lifecycle: 'active' }] });
                const result = await dispatch('tasks/list-v1', { v: 1,
                    sources: { kind: 'allConfigured' }, limit: 10, order: 'newest', tasks: { completedSinceMs: 0 } });
                expect(result).toMatchObject({ window: { rows: [{ entryRef: { entryId: 'personal-task' } }] } });
                if (!withMachine && !withGithub) {
                    const { TriageListEntriesResultV1Schema } = await import('../../../../../../../packages/plugins/triage/src/actions/listEntriesProtocol');
                    const { readTriageEntryDetailState } = await import('../../../../../../../packages/plugins/triage/src/ui/detail/useTriageEntryDetail');
                    const { resolveTriageSourceDetailContributionV1 } = await import('../../../../../../../packages/plugins/triage/src/ui/detail/sourceSurface');
                    const { readMountedAccountTargetedContributions } = await import('@/components/plugins/surfaces/mountedAccountTargetedContributions');
                    const { prepareTargetedSurfaceMounts } = await import('@/components/plugins/surfaces/mountedTargetedContributions');
                    const { readTargetedPluginSurfaceReactMountRequest } = await import('@/components/plugins/surfaces/TargetedPluginSurfaceHost');
                    const row = TriageListEntriesResultV1Schema.parse(result).window.rows[0]!;
                    if (row.observation.outcome.kind !== 'present') throw new Error('Expected present personal task');
                    const outcome = row.observation.outcome;
                    const detail = await readTriageEntryDetailState({ executeAction: dispatch }, {
                        selection: { entryRef: row.entryRef, sourceInstanceId: row.observation.sourceInstanceId },
                        observation: { entryRef: row.entryRef, observedAtMs: row.observation.observedAtMs,
                            locator: outcome.locator, snapshot: outcome.snapshot, viewer: outcome.viewer },
                    });
                    expect(detail.kind).toBe('ready');
                    if (detail.kind !== 'ready') throw new Error('Expected composed detail read');
                    const mounted = await readMountedAccountTargetedContributions({ pluginId: declaration.pluginId, origin,
                        accountLifetime: lifetime, signal: new AbortController().signal, isCurrent: () => true });
                    const surface = resolveTriageSourceDetailContributionV1(mounted.targetedContributions, INTERNAL_TASK_SOURCE_V1);
                    expect(surface.kind).toBe('admitted');
                    if (surface.kind !== 'admitted') throw new Error('Expected personal detail contribution');
                    expect(readTargetedPluginSurfaceReactMountRequest({
                        presentation: { surface: surface.surface, input: { ...detail.input, panel: 'overview' } },
                        mounts: prepareTargetedSurfaceMounts(mounted.targetedSurfaceMounts), target: mounted.targetedContributions.target,
                    }), 'the read detail must reach its real native mount instead of the caller fallback').not.toBeNull();
                }
                if (withGithub && !availableMachine) expect(result).toMatchObject({ configuredSources: expect.arrayContaining([
                    expect.objectContaining({ sourceInstanceId: personalSourceInstanceId }),
                    expect.objectContaining({ sourceInstanceId: '22222222-2222-4222-8222-222222222222' }),
                ]), window: { lanes: expect.arrayContaining([
                    expect.objectContaining({ source: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 },
                        health: expect.objectContaining({ kind: 'unavailable', error: expect.objectContaining({ code: 'plugin_action_machine_required' }) }) }),
                ]) } });
                if (availableMachine) {
                    expect(result, JSON.stringify(result)).toMatchObject({ window: { lanes: expect.arrayContaining([
                        expect.objectContaining({ source: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 },
                            health: expect.objectContaining({ kind: 'walkFinished' }) }),
                    ]) } });
                    expect(packaged.machineRpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)).toBe(true);
                    if (scenario === 'available Machine linked Resource') {
                        // Real sidebar Resource -> Account Action -> admitted GitHub role.
                        // Resource custody stays Account-scoped; the mounted Machine is
                        // independent addressing for its nested daemon Action.
                        const { createPluginDeclaredResourceStore } = await import('@/components/plugins/surfaces/PluginContextualResourceStoreProvider');
                        const { TriageReadSourceSessionLinksResultV1Schema } = await import('../../../../../../../packages/plugins/triage/src/actions/sessionLinksProtocol');
                        const store = createPluginDeclaredResourceStore({ accountLifetime: lifetime, pluginId: declaration.pluginId,
                            machineId, serverId: lifetime.scope.serverId, expectedCallerOccurrenceId: origin.custodyId,
                            resourcesById: projection.resourcesById, resourceDeclarationsComplete: true, sessionId: 'linked-resource-session' });
                        if (!store) throw new Error('Expected the declared Session Resource store');
                        try {
                            const snapshot = await store.getEntry('session-links-v1').refresh();
                            expect(snapshot.error).toBeUndefined();
                            const linked = TriageReadSourceSessionLinksResultV1Schema.parse(JSON.parse(new TextDecoder().decode(snapshot.value!.bytes)));
                            expect(linked, JSON.stringify(linked)).toMatchObject({ kind: 'complete', links: [] });
                            expect(packaged.machineRpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE
                                && request.payload.qualifiedActionId === `${GITHUB_PLUGIN_ID}/${githubNativeReadActionId(GITHUB_TRIAGE_ACTION_IDS_V1.readSessionLinks)}`)).toHaveLength(1);
                        } finally { store.dispose(); }
                        // The sibling Machine-sources case exercises Settings;
                        // this case ends at the Session Resource's composed read.
                        return;
                    }
                    // The exact Settings Action shares the real schema/RPC dispatcher
                    // with the aggregate, while keeping its own mounted GitHub caller.
                    // This establishes the controller contract, not physical Host or
                    // Administration-selection readiness.
                    const { readReusableDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
                    const { readPluginSurfaceMountBinding } = await import('@/components/plugins/surfaces/pluginSurfaceMountBinding');
                    const cached = readReusableDaemonMergedProjectionCacheEntry({ machineId,
                        serverId: lifetime.scope.serverId, accountLifetime: lifetime });
                    expect(cached?.kind).toBe('ready');
                    if (cached?.kind !== 'ready') throw new Error('Expected the current Machine projection');
                    const exact = mergeInstalledPluginUiProjections([readCurrentAppShellPluginUiProjection()!],
                        cached.inputs.pluginUiProjection)!;
                    const page = Object.values(exact.settingsPagesById).find(row => row.pluginId === GITHUB_PLUGIN_ID
                        && row.descriptorId === GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.settingsPageId);
                    if (!page) throw new Error('Expected the authored GitHub Settings page');
                    const mounted = readPluginSurfaceMountBinding({ descriptor: page, renderer: page.renderer });
                    if (mounted?.kind !== 'destination') throw new Error('Expected the Settings destination binding');
                    const action = exact.actionsById[`${GITHUB_PLUGIN_ID}/triage/list-github-instances`];
                    if (!action?.occurrenceId) throw new Error('Expected exact GitHub Action custody');
                    const settingsOrigin = readPluginUiAccountExecutableOrigin(action);
                    if (!settingsOrigin) throw new Error('Expected the GitHub Account Settings origin');
                    let current = true;
                    const settingsController = createBoundPluginSurfaceController({ facts: {
                        pluginId: page.pluginId, contributionId: mounted.destinationBinding.destination.localId,
                        surfaceId: page.id, placement: mounted.destinationBinding.surfaceContextPlacement,
                        platform: 'web', channel: 'internal', machineId, serverId: lifetime.scope.serverId,
                        accountLifetime: lifetime, occurrenceId: settingsOrigin.custodyId,
                        accountExecutionOrigin: settingsOrigin, daemonOccurrenceId: machineOccurrenceId, pluginUiProjection: exact,
                        resolveContributedAction: createPluginUiProjectedActionResolver(exact.actionsById),
                        interactionEnabled: true, daemonInteractionEnabled: true,
                    }, binding: { executeHostAction: scopedHomeActionExecutor(lifetime.scope),
                        isExecutionOriginCurrent: () => current } });
                    try {
                        expect(await settingsController.dispatchAction('triage/list-github-instances', { v: 1 }))
                            .toEqual({ kind: 'complete', candidates: [], failures: [] });
                        const before = packaged.machineRpc.mock.calls.length;
                        current = false;
                        expect(await settingsController.dispatchAction('triage/list-github-instances', { v: 1 }))
                            .toMatchObject({ code: 'unavailable', diagnostics: ['plugin_surface_contributed_action_unavailable'] });
                        expect(packaged.machineRpc.mock.calls).toHaveLength(before);
                    } finally { settingsController.dispose(); }
                }
            } else {
                const created = TriageTaskWriteResultV1Schema.parse(await dispatch('tasks/create-v1', {
                    v: 1, source: INTERNAL_TASK_SOURCE_V1, sourceInstanceId: personalSourceInstanceId,
                    kindId: 'task', fields: { title: 'Created through Account UI' },
                }));
                expect(created.kind, JSON.stringify(created)).toBe('applied');
                if (created.kind !== 'applied') throw new Error('Account UI create did not apply');
                expect(created.observation.snapshot.title).toBe('Created through Account UI');
                const entryRef = { source: INTERNAL_TASK_SOURCE_V1, ...created.observation.localRef };
                const address = { v: 1, sourceInstanceId: personalSourceInstanceId, entryRef };
                expect(await dispatch('tasks/edit-v1', { ...address,
                    fields: { title: 'Edited through Account UI' } })).toMatchObject({ kind: 'applied',
                        observation: { snapshot: { title: 'Edited through Account UI' } } });
                expect(await dispatch('tasks/transition-v1', { ...address,
                    transitionId: 'completed' })).toMatchObject({ kind: 'applied',
                        observation: { snapshot: { state: { presentation: 'resolved' } } } });
                expect(await dispatch('entries/reobserve-v1', address)).toMatchObject({ kind: 'observed',
                    observation: { outcome: { snapshot: { title: 'Edited through Account UI', state: { presentation: 'resolved' } } } } });
                // Reversible personal writes use the source's safe/direct policy.
                expect(vi.mocked(Modal.show).mock.calls.filter(([config]) =>
                    config.chrome?.testID === 'app-shell-transient-interaction-dialog')).toHaveLength(0);
                expect([...todoRows.keys()].filter(key => key !== 'todo.index')).toHaveLength(2);
            }
            if (!withMachine) expect(packaged.machineRpc).not.toHaveBeenCalled();
            },
        };
    } catch (error) {
        await screen.unmount();
        throw error;
    }
}

describe.each(TRIAGE_ACCOUNT_DISPATCH_SCENARIOS)('runs actual Triage through the UI Account dispatcher: %s', scenario => {
    let fixture: Awaited<ReturnType<typeof prepareTriageAccountDispatchScenario>> | undefined;
    beforeEach(async () => {
        if (scenario === 'personal search' || scenario === 'Home search') {
            fixture = await prepareTriageAccountDispatchScenario(scenario);
        }
    });
    afterEach(async () => {
        await fixture?.dispose();
        fixture = undefined;
    });
    it('dispatches through the current Account executable', async () => {
        fixture ??= await prepareTriageAccountDispatchScenario(scenario);
        await fixture.run();
    });
});

it('opens the existing Session picker from actual native Task Send without a Machine', async () => {
    const fixture = await prepareTriageAccountDispatchScenario('personal send picker');
    try { await fixture.run(); } finally { await fixture.dispose(); }
});

it('completes a Triage task through the real mounted inline host control', async () => {
    const { Platform } = await import('react-native');
    const previous = Platform.OS;
    // These artifacts execute in the native host; browser Account Actions need
    // a receiving Machine, which this Account-only fixture intentionally lacks.
    Object.assign(Platform, { OS: 'ios' });
    try {
        const fixture = await prepareTriageAccountDispatchScenario('personal host controls');
        try { await fixture.run(); } finally { await fixture.dispose(); }
    } finally { Object.assign(Platform, { OS: previous }); }
});
