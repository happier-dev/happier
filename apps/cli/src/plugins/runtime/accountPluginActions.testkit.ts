import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionInputV1Schema, PluginAvailabilityIntentReadActionOutputV1Schema,
    PluginAvailabilityUiArtifactReadActionInputV1Schema, PluginAvailabilityUiArtifactReadActionOutputV1Schema,
    normalizePluginReleaseFactsV1 } from '@happier-dev/protocol/plugins/availability';
import { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1,
    createPluginUiArtifactArchiveV1, encodePluginUiArtifactArchiveBodyV1, PluginUiArtifactsManifestV2Schema } from '@happier-dev/protocol/plugins/ui';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectVerifiedPluginUiReleaseSlotsV2 } from '@/plugins/availability/releaseFacts';
import { registerPlainArtifactRoutes } from '@/session/actions/widgetApproval.testkit';
import { compileUniversalPluginUiCommonJs } from '../../../../../packages/plugin-sdk/src/ui/build/universalCommonJsCompiler';
import { readWorkspacePackages, packageNameOfSpecifier, resolveWorkspaceSource } from '../../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { manifest as authoredAccountManifest, sourceProviderManifest } from '../../../../../packages/plugin-sdk/fixtures/account-actions/src/index';

/** Real public-author compiler and release producers, with only Home HTTP storage replaced. */
export async function registerAuthoredAccountActionRelease(app: FastifyInstance, accountId: string,
    options: Readonly<{ includeAccountProvider?: boolean; includeBundledPluginIds?: readonly string[];
        /** A package-owned author fixture using this same compiler/release/storage boundary. */
        primary?: Readonly<{ manifest: unknown; projectRoot: string; entryPath: string;
            artifactId?: string; activateExport?: string; manifestExport?: string | null }> }> = {}) {
    const projectRoot = resolve(import.meta.dirname, '../../../../../packages/plugin-sdk/fixtures/account-actions');
    const packages = await readWorkspacePackages(resolve(import.meta.dirname, '../../../../..'));
    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
        exports: Record<string, string>;
    };
    const buildRelease = async (input: Readonly<{ manifest: unknown; artifactId: string; accountArtifactId: string;
        manifestExport: string | null; activateExport: string; archiveDigestCharacter: string }>) => {
        const authored = input.artifactId === (options.primary?.artifactId ?? 'account-runtime') ? options.primary : undefined;
        const manifest = normalizePluginManifestV2(input.manifest);
        const pluginId = manifest.id;
        const compiled = await compileUniversalPluginUiCommonJs({ projectRoot: authored?.projectRoot ?? projectRoot,
            entryPath: authored?.entryPath ?? resolve(projectRoot, packageJson.exports[`./happier-plugin-ui/${input.artifactId}`]!),
            artifactId: input.artifactId, requestedExports: [...(input.manifestExport ? [input.manifestExport] : []), input.activateExport], exportConditions: ['happier-source'],
            resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
                ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined });
        const bytes = compiled.bytes;
        const entry = `react-native/${input.artifactId}/entry.cjs.bundle`;
        const files = [{ relativePath: entry, bytes }];
        const generated = PluginUiArtifactsManifestV2Schema.parse({ version: 2, entries: [{
            artifactId: input.artifactId, tier: 'reactNative', entry,
            files: [{ relativePath: entry, byteSize: bytes.length, digest: computePluginUiArtifactSha256DigestV1(bytes) }],
            digest: computePluginUiArtifactFileSetSha256DigestV1(files), builtWith: { bundler: 'esbuild', version: '0.27.2' },
            executable: { exports: [input.activateExport] }, hostUiApiRange: '^1.0.0' }] });
        const archive = createPluginUiArtifactArchiveV1({ pluginId, artifactGraph: generated.entries[0], files });
        if (!archive) throw new Error('invalid canonical fixture');
        const release = normalizePluginReleaseFactsV1({ ref: { pluginId, version: manifest.version },
            archiveDigestSha256: `sha256:${input.archiveDigestCharacter.repeat(64)}`, normalizedManifest: manifest, collectionContracts: [],
            uiSlots: projectVerifiedPluginUiReleaseSlotsV2({ manifest, generatedUiArtifacts: generated }),
            packageAssetArchive: { archiveDigestSha256: `sha256:${'d'.repeat(64)}`, resources: [] } });
        return { pluginId, artifactId: input.accountArtifactId, manifest, generated, files, archive, release };
    };
    const primary = await buildRelease({ manifest: options.primary?.manifest ?? authoredAccountManifest, artifactId: options.primary?.artifactId ?? 'account-runtime',
        accountArtifactId: 'a7e5d73f-88a7-44bc-98ed-23edbffb6214', manifestExport: options.primary?.manifestExport === undefined ? 'manifest' : options.primary.manifestExport,
        activateExport: options.primary?.activateExport ?? 'activate', archiveDigestCharacter: 'a' });
    const provider = options.includeAccountProvider ? await buildRelease({ manifest: sourceProviderManifest,
        artifactId: 'account-source-provider-runtime', accountArtifactId: 'b7e5d73f-88a7-44bc-98ed-23edbffb6214',
        manifestExport: 'sourceProviderManifest', activateExport: 'activateSourceProvider', archiveDigestCharacter: 'b' }) : null;
    const fixtures = provider ? [primary, provider] : [primary];
    const enabled = new Map(fixtures.map(fixture => [fixture.pluginId, true]));
    let bundledFallback = false;
    const response = (fixture: typeof primary | undefined) => PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
        hostingCapability: { enabled: true, maxArtifactBytes: 16 * 1024 * 1024, maxAccountBytes: 256 * 1024 * 1024 },
        intent: !fixture || (bundledFallback && fixture === primary) ? null : {
            pluginId: fixture.pluginId, desiredVersion: fixture.manifest.version, enabled: enabled.get(fixture.pluginId),
            offlineUiHosting: 'enabled', revision: '1', writableCollections: [] },
        release: !fixture || (bundledFallback && fixture === primary) ? null : fixture.release,
        uiArtifacts: !fixture || (bundledFallback && fixture === primary) ? [] : fixture.release.uiSlots.map(slot => ({ release: fixture.release.ref, contributionId: slot.contributionId,
            artifactId: slot.artifactId, tier: slot.tier, platform: slot.platform,
            artifactDigest: slot.artifactDigest, hostUiApiRange: slot.hostUiApiRange, accountArtifactId: fixture.artifactId })), packageAssets: [] });
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async () => ({
        availabilityCursor: 1, pluginIds: [...fixtures.map(fixture => fixture.pluginId), ...(options.includeBundledPluginIds ?? [])],
        intentReads: [...fixtures.map(fixture => ({ pluginId: fixture.pluginId, response: response(fixture) })),
            ...(options.includeBundledPluginIds ?? []).map(pluginId => ({ pluginId, response: response(undefined) }))], failedPluginIds: [] }));
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async request => {
        const { pluginId } = PluginAvailabilityIntentReadActionInputV1Schema.parse(request.body);
        return response(fixtures.find(fixture => fixture.pluginId === pluginId));
    });
    const artifacts = registerPlainArtifactRoutes(app, accountId);
    for (const fixture of fixtures) artifacts.seed(fixture.artifactId, encodePlainArtifactStoredContent(fixture.archive.header),
        encodePlainArtifactStoredContent({ body: encodePluginUiArtifactArchiveBodyV1(fixture.archive.body) }));
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.uiArtifact.read'], async (request, reply) => {
        const input = PluginAvailabilityUiArtifactReadActionInputV1Schema.parse(request.body);
        const fixture = fixtures.find(fixture => fixture.pluginId === input.release.pluginId
            && fixture.manifest.version === input.release.version);
        const link = response(fixture).uiArtifacts.find(link => link.contributionId === input.contributionId
            && link.artifactId === input.artifactId && link.tier === input.tier && link.platform === input.platform);
        const stored = fixture ? artifacts.read(fixture.artifactId) : null;
        if (!link || !stored) return reply.code(404).send({ error: 'plugin_ui_artifact_not_found' });
        return PluginAvailabilityUiArtifactReadActionOutputV1Schema.parse({ link, artifact: {
            header: stored.header, headerVersion: stored.headerVersion, body: stored.body, bodyVersion: stored.bodyVersion,
            dataEncryptionKey: stored.dataEncryptionKey, seq: stored.seq,
        } });
    });
    const setPluginEnabled = (pluginId: string, value: boolean) => {
        if (!enabled.has(pluginId)) throw new Error('unknown authored fixture plugin');
        enabled.set(pluginId, value);
    };
    return { ...primary, providerPluginId: provider?.pluginId, artifacts, setPluginEnabled,
        setEnabled: (value: boolean) => { setPluginEnabled(primary.pluginId, value); },
        setBundledFallback: (value = true) => { bundledFallback = value; } };
}
