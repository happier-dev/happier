import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { derivePluginAccountExecutionArtifactSlots } from '@happier-dev/protocol/plugins/contributions/catalog';
import { createPackageAssetArchiveV1, readDeclaredPackageAssetsV1 } from '@happier-dev/protocol/plugins/availability/packageAssetV1';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionInputV1Schema, PluginAvailabilityIntentReadActionOutputV1Schema,
    PluginAvailabilityUiArtifactReadActionInputV1Schema, PluginAvailabilityUiArtifactReadActionOutputV1Schema,
    PluginAvailabilityIntentsListActionInputV1Schema, PluginAvailabilityIntentsListActionOutputV1Schema,
    PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE, normalizePluginReleaseFactsV1 } from '@happier-dev/protocol/plugins/availability';
import { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1,
    createPluginUiArtifactArchiveV1, encodePluginUiArtifactArchiveBodyV1, PluginUiArtifactsManifestV2Schema } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiArtifactsManifestV2 } from '@happier-dev/protocol/plugins/ui';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectVerifiedPluginUiReleaseSlotsV2 } from '@/plugins/availability/releaseFacts';
import { registerAccountArtifactRoutes } from '@/session/actions/widgetApproval.testkit';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { StoredCredentials } from '@/persistence';
import { compileUniversalPluginUiCommonJs } from '../../../../../packages/plugin-sdk/src/ui/build/universalCommonJsCompiler';
import { readWorkspacePackages, packageNameOfSpecifier, resolveWorkspaceSource } from '../../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { manifest as authoredAccountManifest, sourceProviderManifest } from '../../../../../packages/plugin-sdk/fixtures/account-actions/src/index';

type AuthoredAccountReleaseSource = Readonly<{ manifest: unknown; projectRoot: string; entryPath: string;
    artifactId?: string; activateExport?: string; manifestExport?: string | null }>;

type AuthoredAccountArtifactArchive = NonNullable<ReturnType<typeof createPluginUiArtifactArchiveV1>>;

export type AuthoredAccountActionRelease = {
    pluginId: string;
    artifactId: string;
    manifest: CanonicalPluginManifest;
    generated: PluginUiArtifactsManifestV2;
    files: { relativePath: string; bytes: Uint8Array }[];
    archive: AuthoredAccountArtifactArchive;
    hostedArtifacts: { artifactId: string; graphArtifactId: string; archive: AuthoredAccountArtifactArchive }[];
    release: ReturnType<typeof normalizePluginReleaseFactsV1>;
};

export type RegisteredAuthoredAccountActionRelease = AuthoredAccountActionRelease & {
    providerPluginId: string | undefined;
    artifacts: ReturnType<typeof registerAccountArtifactRoutes<'plain' | 'e2ee'>>;
    publishArtifacts: (credentials: StoredCredentials) => Promise<void>;
    setPluginEnabled: (pluginId: string, value: boolean) => void;
    setEnabled: (value: boolean) => void;
    setBundledFallback: (value?: boolean) => void;
};

/** Canonical author compiler and release projection, independent of Home storage. */
export async function buildAuthoredAccountActionRelease(input: Readonly<{ manifest: unknown; artifactId: string; accountArtifactId: string;
        manifestExport: string | null; activateExport: string; archiveDigestCharacter: string; source?: AuthoredAccountReleaseSource }>): Promise<AuthoredAccountActionRelease> {
    const projectRoot = resolve(import.meta.dirname, '../../../../../packages/plugin-sdk/fixtures/account-actions');
    const packages = await readWorkspacePackages(resolve(import.meta.dirname, '../../../../..'));
    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
        exports: Record<string, string>;
    };
    const manifest = normalizePluginManifestV2(input.manifest);
    const pluginId = manifest.id;
    const authored = input.source;
    const artifactSources = new Map([[input.artifactId, {
        entryPath: authored?.entryPath ?? resolve(projectRoot, packageJson.exports[`./happier-plugin-ui/${input.artifactId}`]!),
        activationExports: new Set([input.activateExport]),
    }]]);
    if (authored) {
        const authoredPackage = JSON.parse(await readFile(join(authored.projectRoot, 'package.json'), 'utf8')) as { name: string };
        for (const slot of derivePluginAccountExecutionArtifactSlots(manifest.contributes)) {
            const { artifactId, exportName } = slot.registrationRight.target;
            const existing = artifactSources.get(artifactId);
            if (existing) existing.activationExports.add(exportName);
            else artifactSources.set(artifactId, {
                entryPath: resolveWorkspaceSource(packages, `${authoredPackage.name}/happier-plugin-ui/${artifactId}`),
                activationExports: new Set([exportName]),
            });
        }
    }
    const compiledArtifacts = await Promise.all([...artifactSources].map(async ([artifactId, source]) => {
        const primaryArtifact = artifactId === input.artifactId;
        const compiled = await compileUniversalPluginUiCommonJs({ projectRoot: authored?.projectRoot ?? projectRoot,
            entryPath: source.entryPath, artifactId,
            requestedExports: [...(primaryArtifact && input.manifestExport ? [input.manifestExport] : []), ...source.activationExports,
                // Only the default dual-host fixture promises a daemon export.
                ...(!authored && artifactId === 'account-runtime' ? ['activate'] : [])], exportConditions: ['happier-source'],
            resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
                ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined });
        const bytes = compiled.bytes;
        const entry = `react-native/${artifactId}/entry.cjs.bundle`;
        const files = [{ relativePath: entry, bytes }];
        return { files, graph: { artifactId, tier: 'reactNative', entry,
            files: [{ relativePath: entry, byteSize: bytes.length, digest: computePluginUiArtifactSha256DigestV1(bytes) }],
            digest: computePluginUiArtifactFileSetSha256DigestV1(files), builtWith: { bundler: 'esbuild', version: '0.27.2' },
            executable: { exports: [...source.activationExports] }, hostUiApiRange: '^1.0.0' } };
    }));
    const generated = PluginUiArtifactsManifestV2Schema.parse({ version: 2, entries: compiledArtifacts.map(artifact => artifact.graph) });
    const hostedArtifacts = generated.entries.map((graph, index) => {
        const archive = createPluginUiArtifactArchiveV1({ pluginId, artifactGraph: graph, files: compiledArtifacts[index]!.files });
        if (!archive) throw new Error('invalid canonical fixture');
        return { artifactId: index === 0 ? input.accountArtifactId : randomUUID(), graphArtifactId: graph.artifactId, archive };
    });
    const files = compiledArtifacts.flatMap(artifact => artifact.files);
    const archive = hostedArtifacts[0]!.archive;
    const declaredAssets = readDeclaredPackageAssetsV1(manifest);
    if (!declaredAssets) throw new Error('invalid fixture package assets');
    const packageAssetArchive = createPackageAssetArchiveV1({ manifest, files: await Promise.all(declaredAssets.map(async asset => ({
        path: asset.path, bytes: await readFile(join(authored?.projectRoot ?? projectRoot, asset.path)),
    }))) });
    if (!packageAssetArchive) throw new Error('invalid fixture package asset archive');
    const release = normalizePluginReleaseFactsV1({ ref: { pluginId, version: manifest.version },
        archiveDigestSha256: `sha256:${input.archiveDigestCharacter.repeat(64)}`, normalizedManifest: manifest, collectionContracts: [],
        uiSlots: projectVerifiedPluginUiReleaseSlotsV2({ manifest, generatedUiArtifacts: generated }),
        packageAssetArchive: packageAssetArchive.descriptor });
    return { pluginId, artifactId: input.accountArtifactId, manifest, generated, files, archive, hostedArtifacts, release };
}

/** Real public-author compiler and release producers, with only Home HTTP storage replaced. */
export async function registerAuthoredAccountActionRelease(app: FastifyInstance, accountId: string,
    options: Readonly<{ includeAccountProvider?: boolean; includeBundledPluginIds?: readonly string[]; encryptionMode?: 'plain' | 'e2ee';
        scopedProjectKeys?: readonly string[];
        /** A package-owned author fixture using this same compiler/release/storage boundary. */
        primary?: AuthoredAccountReleaseSource; additional?: readonly AuthoredAccountReleaseSource[] }> = {}): Promise<RegisteredAuthoredAccountActionRelease> {
    const primary = await buildAuthoredAccountActionRelease({ manifest: options.primary?.manifest ?? authoredAccountManifest, artifactId: options.primary?.artifactId ?? 'account-runtime',
        accountArtifactId: 'a7e5d73f-88a7-44bc-98ed-23edbffb6214',
        manifestExport: options.primary?.manifestExport === undefined ? 'manifest' : options.primary.manifestExport,
        activateExport: options.primary?.activateExport ?? 'activateAccount', archiveDigestCharacter: 'a', source: options.primary });
    const provider = options.includeAccountProvider ? await buildAuthoredAccountActionRelease({ manifest: sourceProviderManifest,
        artifactId: 'account-source-provider-runtime', accountArtifactId: 'b7e5d73f-88a7-44bc-98ed-23edbffb6214',
        manifestExport: 'sourceProviderManifest', activateExport: 'activateSourceProvider', archiveDigestCharacter: 'b' }) : null;
    const additional = await Promise.all((options.additional ?? []).map(source => buildAuthoredAccountActionRelease({ manifest: source.manifest,
        artifactId: source.artifactId ?? 'account-runtime', accountArtifactId: randomUUID(),
        manifestExport: source.manifestExport === undefined ? 'manifest' : source.manifestExport,
        activateExport: source.activateExport ?? 'activateAccount', archiveDigestCharacter: 'c', source })));
    const fixtures = [primary, ...(provider ? [provider] : []), ...additional];
    const enabled = new Map(fixtures.map(fixture => [fixture.pluginId, true]));
    let bundledFallback = false;
    const response = (fixture: typeof primary | undefined) => PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
        hostingCapability: { enabled: true, maxArtifactBytes: 16 * 1024 * 1024, maxAccountBytes: 256 * 1024 * 1024 },
        intent: !fixture || (bundledFallback && fixture === primary) ? null : {
            pluginId: fixture.pluginId, desiredVersion: fixture.manifest.version, enabled: enabled.get(fixture.pluginId),
            offlineUiHosting: 'enabled', revision: '1', writableCollections: [],
            ...(fixture === primary && options.scopedProjectKeys
                ? { projectScope: { kind: 'only', projectKeys: [...options.scopedProjectKeys] } } : {}) },
        release: !fixture || (bundledFallback && fixture === primary) ? null : fixture.release,
        uiArtifacts: !fixture || (bundledFallback && fixture === primary) ? [] : fixture.release.uiSlots.map(slot => ({ release: fixture.release.ref, contributionId: slot.contributionId,
            artifactId: slot.artifactId, tier: slot.tier, platform: slot.platform,
            artifactDigest: slot.artifactDigest, hostUiApiRange: slot.hostUiApiRange,
            accountArtifactId: fixture.hostedArtifacts.find(artifact => artifact.graphArtifactId === slot.artifactId)!.artifactId })), packageAssets: [] });
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async request => {
        const input = PluginAvailabilityIntentsListActionInputV1Schema.parse(request.body);
        const fixtureIds = [...fixtures.map(fixture => fixture.pluginId), ...(options.includeBundledPluginIds ?? [])];
        // An exact named read answers only its plugins (absent intents explicitly);
        // a census page lists every intent plus caller-known ids.
        const candidates = (input.pluginIds ? [...new Set(input.pluginIds)]
            : [...new Set([...fixtureIds, ...(input.knownPluginIds ?? [])])])
            .filter(pluginId => !input.cursor || pluginId > input.cursor).sort();
        const pageIds = candidates.slice(0, PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE);
        return PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1,
            pluginIds: pageIds.filter(pluginId => fixtureIds.includes(pluginId)),
            intentReads: pageIds.map(pluginId => ({ pluginId, response: response(fixtures.find(fixture => fixture.pluginId === pluginId)) })),
            failedPluginIds: [], ...(candidates.length > pageIds.length ? { nextCursor: pageIds.at(-1)! } : {}) });
    });
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async request => {
        const { pluginId } = PluginAvailabilityIntentReadActionInputV1Schema.parse(request.body);
        return response(fixtures.find(fixture => fixture.pluginId === pluginId));
    });
    const artifacts = registerAccountArtifactRoutes(app, accountId, { encryptionMode: options.encryptionMode ?? 'plain' });
    if (options.encryptionMode !== 'e2ee') {
        for (const fixture of fixtures) for (const artifact of fixture.hostedArtifacts) {
            artifacts.seed(artifact.artifactId, encodePlainArtifactStoredContent(artifact.archive.header),
                encodePlainArtifactStoredContent({ body: encodePluginUiArtifactArchiveBodyV1(artifact.archive.body) }));
        }
    }
    // E2EE publication follows listen and uses the exact Account's ordinary client writer.
    const publishArtifacts = async (credentials: StoredCredentials) => {
        const store = createCredentialedAccountArtifactStore(credentials);
        for (const fixture of fixtures) for (const artifact of fixture.hostedArtifacts) {
            if (artifacts.read(artifact.artifactId)) continue;
            await store.create({ artifactId: artifact.artifactId, header: artifact.archive.header,
                body: encodePluginUiArtifactArchiveBodyV1(artifact.archive.body) });
        }
    };
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.uiArtifact.read'], async (request, reply) => {
        const input = PluginAvailabilityUiArtifactReadActionInputV1Schema.parse(request.body);
        const fixture = fixtures.find(fixture => fixture.pluginId === input.release.pluginId
            && fixture.manifest.version === input.release.version);
        const link = response(fixture).uiArtifacts.find(link => link.contributionId === input.contributionId
            && link.artifactId === input.artifactId && link.tier === input.tier && link.platform === input.platform);
        const stored = link ? artifacts.read(link.accountArtifactId) : null;
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
    return { ...primary, providerPluginId: provider?.pluginId, artifacts, publishArtifacts, setPluginEnabled,
        setEnabled: (value: boolean) => { setPluginEnabled(primary.pluginId, value); },
        setBundledFallback: (value = true) => { bundledFallback = value; } };
}
