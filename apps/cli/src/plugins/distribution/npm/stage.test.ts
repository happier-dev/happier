import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computePluginUiArtifactFileSetSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestNpmTarball, sriSha512, type TestTarEntry } from '../testkit/npmTarball';
import { cleanupStagedNpmArtifactCandidate, stageDownloadedNpmArtifactCandidate } from './stage';
import type { DownloadedNpmArtifactCandidate } from './types';

const tempDirs: string[] = [];

function uiArtifactFile(relativePath: string, bytes: Uint8Array): Readonly<{
  relativePath: string;
  digest: string;
  byteSize: number;
}> {
  return {
    relativePath,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    byteSize: bytes.byteLength,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type FixtureOverrides = Readonly<{
  packageName?: string;
  packageVersion?: string;
  packageManifestPath?: string;
  packageKeywords?: readonly string[];
  packageFiles?: readonly string[];
  manifestId?: string;
  manifestVersion?: string;
  pluginManifestBody?: string;
  artifactContributionId?: string;
  artifactTier?: 'hostedWeb' | 'reactNative';
  artifactPlatform?: 'web' | 'ios' | 'android';
  artifactDigest?: string;
  artifactEntryPath?: string;
  includeUiRenderer?: boolean;
  includeVoiceProvider?: boolean;
  voiceProviderPlatforms?: readonly ('web' | 'ios' | 'android')[];
  additionalVoiceArtifactPlatforms?: readonly ('ios' | 'android')[];
  additionalVoiceProviderModulePath?: string;
  nativeVoiceArtifactModulePath?: string;
  nativeVoiceArtifactExportName?: string;
  duplicateArtifactSlot?: boolean;
  extraPackageJson?: Readonly<Record<string, unknown>>;
  packageAssets?: readonly Readonly<{
    id: string;
    path: string;
    contentType: string;
    body: string | Uint8Array;
  }>[];
  extraEntries?: readonly TestTarEntry[];
  omitPaths?: readonly string[];
}>;

async function createCandidateFixture(overrides: FixtureOverrides = {}): Promise<Readonly<{
  candidate: DownloadedNpmArtifactCandidate;
  root: string;
  stagingParentPath: string;
  sideEffectPath: string;
}>> {
  const root = await mkdtemp(join(tmpdir(), 'happier-npm-stage-'));
  tempDirs.push(root);
  const stagingParentPath = join(root, 'staging');
  const artifactPath = join(root, 'candidate.tgz');
  const sideEffectPath = join(root, 'lifecycle-script-ran');
  const uiEntryPath = 'hosted-web/panel/entry.mjs';
  const uiBytes = Buffer.from('export default function Panel() {}\n');
  const uiDigest = computePluginUiArtifactFileSetSha256DigestV1([
    { relativePath: uiEntryPath, bytes: uiBytes },
  ]);
  const duplicateUiEntryPath = 'hosted-web/panel/duplicate.mjs';
  const duplicateUiBytes = Buffer.from('export default function DuplicatePanel() {}\n');
  const duplicateUiDigest = computePluginUiArtifactFileSetSha256DigestV1([
    { relativePath: duplicateUiEntryPath, bytes: duplicateUiBytes },
  ]);
  const packageJson = {
    name: overrides.packageName ?? '@acme/happier-plugin',
    version: overrides.packageVersion ?? '1.2.3',
    keywords: overrides.packageKeywords ?? ['happier-plugin'],
    files: overrides.packageFiles ?? [
      '.happier-plugin',
      'dist',
      ...[...new Set((overrides.packageAssets ?? []).map((asset) => asset.path.split('/')[0]!))],
    ],
    happier: { manifest: overrides.packageManifestPath ?? '.happier-plugin/plugin.json' },
    scripts: { preinstall: `touch ${JSON.stringify(sideEffectPath)}` },
    dependencies: { 'should-never-be-installed': '1.0.0' },
    ...overrides.extraPackageJson,
  };
  const pluginManifest = {
    schemaVersion: 2,
    id: overrides.manifestId ?? 'acme.npm-stage',
    version: overrides.manifestVersion ?? '1.2.3',
    displayName: 'Acme npm stage',
    description: 'Candidate staging fixture',
    engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
    entrypoints: { daemon: './dist/daemon.mjs' },
    contributes: {
      ui: {
        renderers: overrides.includeUiRenderer === false ? [] : [
          {
            id: 'panel',
            kind: 'hostedWeb',
            source: { kind: 'artifact', artifact: 'panel-web' },
          },
        ],
      },
      voiceProviders: overrides.includeVoiceProvider ? [
        {
          id: 'conversation',
          title: 'Conversation',
          kind: 'conversation',
          roles: ['realtime_conversation', 'turn_control'],
          platforms: overrides.voiceProviderPlatforms ?? ['web'],
          capabilities: {
            turn: { cancelResponse: true, bargeIn: false },
          },
          client: {
            artifactId: 'voice-runtime-web',
            modulePath: './voiceRuntime',
            exportName: 'activate',
          },
        },
        ...(overrides.additionalVoiceProviderModulePath ? [{
          id: 'conversation-secondary',
          title: 'Secondary conversation',
          kind: 'conversation',
          roles: ['realtime_conversation'],
          platforms: overrides.voiceProviderPlatforms ?? ['web'],
          capabilities: {
            turn: { cancelResponse: true, bargeIn: false },
          },
          client: {
            artifactId: 'voice-runtime-web',
            modulePath: overrides.additionalVoiceProviderModulePath,
            exportName: 'activate',
          },
        }] : []),
      ] : [],
      resources: (overrides.packageAssets ?? []).map((asset) => ({
        id: asset.id,
        kind: 'asset',
        path: asset.path,
        contentType: asset.contentType,
      })),
    },
  };
  const artifactManifest = {
    version: 1,
    entries: [
      {
        contributionId: overrides.artifactContributionId ?? 'panel-web',
        tier: overrides.artifactTier ?? 'hostedWeb',
        ...(overrides.artifactPlatform !== undefined
          ? { platform: overrides.artifactPlatform }
          : overrides.artifactTier === 'reactNative'
            ? { platform: 'web' }
            : {}),
        entry: overrides.artifactEntryPath ?? uiEntryPath,
        files: [uiArtifactFile(overrides.artifactEntryPath ?? uiEntryPath, uiBytes)],
        digest: overrides.artifactDigest ?? uiDigest,
        builtWith: { bundler: 'vite', version: '7.0.0' },
        hostUiApiVersion: '1.0.0',
        // Mirrors what the public SDK builders emit: `hostedWebBuild.ts` writes
        // `compat: {}` and only the React Native builders declare compatibility.
        compat: overrides.artifactTier === 'reactNative'
          ? { react: '19.2.0', reactNative: '0.83.4' }
          : {},
      },
      ...((overrides.additionalVoiceArtifactPlatforms ?? []).map((platform) => {
        const relativePath = `react-native/voice-runtime-web/${platform}.bundle`;
        const bytes = Buffer.from(`export function activate() { /* ${platform} */ }\n`);
        return {
          contributionId: 'voice-runtime-web',
          tier: 'reactNative' as const,
          platform,
          entry: relativePath,
          files: [uiArtifactFile(relativePath, bytes)],
          digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath, bytes }]),
          builtWith: { bundler: 'repack' as const, version: '5.2.5' },
          repack: {
            containerName: 'happier_voice_runtime_web_native',
            modulePath: overrides.nativeVoiceArtifactModulePath ?? './voiceRuntime',
            exportName: overrides.nativeVoiceArtifactExportName ?? 'activate',
          },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        };
      })),
      ...(overrides.duplicateArtifactSlot ? [{
        contributionId: overrides.artifactContributionId ?? 'panel-web',
        tier: overrides.artifactTier ?? 'hostedWeb',
        ...(overrides.artifactPlatform !== undefined
          ? { platform: overrides.artifactPlatform }
          : overrides.artifactTier === 'reactNative'
            ? { platform: 'web' }
            : {}),
        entry: duplicateUiEntryPath,
        files: [uiArtifactFile(duplicateUiEntryPath, duplicateUiBytes)],
        digest: duplicateUiDigest,
        builtWith: { bundler: 'vite', version: '7.0.0' },
        hostUiApiVersion: '1.0.0',
        // Mirrors what the public SDK builders emit: `hostedWebBuild.ts` writes
        // `compat: {}` and only the React Native builders declare compatibility.
        compat: overrides.artifactTier === 'reactNative'
          ? { react: '19.2.0', reactNative: '0.83.4' }
          : {},
      }] : []),
    ],
  };
  const entries: TestTarEntry[] = [
    { name: 'package/package.json', body: JSON.stringify(packageJson) },
    { name: 'package/.happier-plugin/plugin.json', body: overrides.pluginManifestBody ?? JSON.stringify(pluginManifest) },
    { name: 'package/dist/daemon.mjs', body: 'export function activate() {}\n' },
    { name: 'package/dist/happier-plugin-ui/ui-artifacts.json', body: JSON.stringify(artifactManifest) },
    { name: `package/dist/happier-plugin-ui/${uiEntryPath}`, body: uiBytes },
    ...((overrides.additionalVoiceArtifactPlatforms ?? []).map((platform) => ({
      name: `package/dist/happier-plugin-ui/react-native/voice-runtime-web/${platform}.bundle`,
      body: `export function activate() { /* ${platform} */ }\n`,
    }))),
    ...(overrides.duplicateArtifactSlot
      ? [{ name: `package/dist/happier-plugin-ui/${duplicateUiEntryPath}`, body: duplicateUiBytes }]
      : []),
    ...(overrides.packageAssets ?? []).map((asset) => ({
      name: `package/${asset.path}`,
      body: asset.body,
    })),
    ...(overrides.extraEntries ?? []),
  ];
  const omittedPaths = new Set(overrides.omitPaths ?? []);
  const bytes = await createTestNpmTarball(entries.filter((entry) => !omittedPaths.has(entry.name)));
  await writeFile(artifactPath, bytes);
  return {
    root,
    stagingParentPath,
    sideEffectPath,
    candidate: {
      source: {
        kind: 'npm',
        registryOrigin: 'https://registry.example.test',
        packageName: '@acme/happier-plugin',
        version: '1.2.3',
        integrity: sriSha512(bytes),
        tarballUrl: 'https://registry.example.test/@acme/happier-plugin/-/happier-plugin-1.2.3.tgz',
      },
      artifactPath,
      byteLength: bytes.byteLength,
      archiveDigestSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      registrySignature: { status: 'verified', keyid: 'SHA256:test-key' },
      provenance: { status: 'absent' },
    },
  };
}

describe('stageDownloadedNpmArtifactCandidate', () => {
  it('accepts the hostedWeb platform identity emitted by the public SDK builder', async () => {
    const fixture = await createCandidateFixture({
      artifactPlatform: 'web',
    });

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({ ok: true });
  });

  it('retains the exact tarball SHA-256 from verified acquisition rather than a staged tree digest', async () => {
    const fixture = await createCandidateFixture();

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({
      ok: true,
      candidate: {
        archiveDigestSha256: fixture.candidate.archiveDigestSha256,
      },
    });
  });

  it('retains one deterministic archive of only the manifest-declared packaged asset Resources', async () => {
    const fixture = await createCandidateFixture({
      packageAssets: [
        { id: 'zeta', path: 'assets/zeta.png', contentType: 'image/png', body: new Uint8Array([9, 8, 7]) },
        { id: 'alpha', path: 'assets/alpha.svg', contentType: 'image/svg+xml', body: new Uint8Array([4, 5]) },
      ],
      extraEntries: [{ name: 'package/assets/unclaimed.txt', body: 'must not be admitted' }],
    });

    const result = await stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    });

    expect(result).toMatchObject({
      ok: true,
      candidate: {
        packageAssetArchive: {
          descriptor: {
            resources: [
              expect.objectContaining({ resourceId: 'alpha', path: 'assets/alpha.svg', mimeType: 'image/svg+xml', byteSize: 2 }),
              expect.objectContaining({ resourceId: 'zeta', path: 'assets/zeta.png', mimeType: 'image/png', byteSize: 3 }),
            ],
          },
          body: {
            resources: [
              expect.objectContaining({ resourceId: 'alpha', bytesBase64: 'BAU=' }),
              expect.objectContaining({ resourceId: 'zeta', bytesBase64: 'CQgH' }),
            ],
          },
        },
      },
    });
    if (result.ok) await cleanupStagedNpmArtifactCandidate(result.candidate);
  });

  it('derives compatibility facts from the staged manifest and generated UI inventory instead of package metadata', async () => {
    const fixture = await createCandidateFixture({
      extraPackageJson: {
        happier: {
          manifest: '.happier-plugin/plugin.json',
          compatibilityProjection: {
            version: 1,
            manifest: {
              schemaVersion: 2,
              id: 'acme.author-supplied-projection',
              version: '9.9.9',
              displayName: 'Forged projection',
              runtime: { apiVersion: 1 },
              contributes: {},
            },
            uiArtifacts: { version: 1, entries: [] },
            builtWith: { pluginSdk: '9999.0.0' },
          },
        },
      },
    });

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({
      ok: true,
      candidate: {
        compatibilityProjection: {
          version: 1,
          manifest: { id: 'acme.npm-stage', version: '1.2.3' },
          uiArtifacts: { version: 1, entries: [expect.objectContaining({ contributionId: 'panel-web' })] },
        },
      },
    });
  });

  it('rejects native platform identities for a hostedWeb artifact', async () => {
    const fixture = await createCandidateFixture({
      artifactPlatform: 'ios',
    });

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({
      ok: false,
      rejection: { code: 'ui_artifact_identity_mismatch' },
    });
  });

  it('accepts a Voice-only generated web client artifact without a fake UI renderer', async () => {
    const fixture = await createCandidateFixture({
      includeUiRenderer: false,
      includeVoiceProvider: true,
      artifactContributionId: 'voice-runtime-web',
      artifactTier: 'reactNative',
    });

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({
      ok: true,
      candidate: { generatedUiArtifacts: { contributionIds: ['voice-runtime-web'] } },
    });
  });

  it('accepts exactly the generated Vite/Re.Pack siblings declared by a Voice provider', async () => {
    const fixture = await createCandidateFixture({
      includeUiRenderer: false,
      includeVoiceProvider: true,
      voiceProviderPlatforms: ['web', 'ios', 'android'],
      artifactContributionId: 'voice-runtime-web',
      artifactTier: 'reactNative',
      additionalVoiceArtifactPlatforms: ['ios', 'android'],
    });

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ['module', { nativeVoiceArtifactModulePath: './otherRuntime' }],
    ['export', { nativeVoiceArtifactExportName: 'otherActivate' }],
  ] satisfies readonly [string, FixtureOverrides][])('rejects a native Voice artifact whose Re.Pack %s identity differs from its declaration', async (_case, overrides) => {
    const fixture = await createCandidateFixture({
      includeUiRenderer: false,
      includeVoiceProvider: true,
      voiceProviderPlatforms: ['web', 'ios'],
      artifactContributionId: 'voice-runtime-web',
      artifactTier: 'reactNative',
      additionalVoiceArtifactPlatforms: ['ios'],
      ...overrides,
    });

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({
      ok: false,
      rejection: { code: 'ui_artifact_identity_mismatch' },
    });
  });

  it('rejects shared native Voice artifacts whose declarations disagree about the Re.Pack module', async () => {
    const fixture = await createCandidateFixture({
      includeUiRenderer: false,
      includeVoiceProvider: true,
      voiceProviderPlatforms: ['web', 'ios'],
      additionalVoiceProviderModulePath: './otherRuntime',
      artifactContributionId: 'voice-runtime-web',
      artifactTier: 'reactNative',
      additionalVoiceArtifactPlatforms: ['ios'],
    });

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({
      ok: false,
      rejection: { code: 'manifest_invalid' },
    });
  });

  it('rejects Voice artifacts that omit or add an undeclared platform sibling', async () => {
    const missing = await createCandidateFixture({
      includeUiRenderer: false,
      includeVoiceProvider: true,
      voiceProviderPlatforms: ['web', 'ios'],
      artifactContributionId: 'voice-runtime-web',
      artifactTier: 'reactNative',
    });
    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: missing.candidate,
      stagingParentPath: missing.stagingParentPath,
    })).resolves.toMatchObject({ ok: false, rejection: { code: 'ui_artifact_identity_mismatch' } });

    const undeclared = await createCandidateFixture({
      includeUiRenderer: false,
      includeVoiceProvider: true,
      voiceProviderPlatforms: ['web'],
      artifactContributionId: 'voice-runtime-web',
      artifactTier: 'reactNative',
      additionalVoiceArtifactPlatforms: ['ios'],
    });
    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: undeclared.candidate,
      stagingParentPath: undeclared.stagingParentPath,
    })).resolves.toMatchObject({ ok: false, rejection: { code: 'ui_artifact_identity_mismatch' } });
  });

  it.each([
    ['missing graph', {
      omitPaths: [
        'package/dist/happier-plugin-ui/ui-artifacts.json',
        'package/dist/happier-plugin-ui/hosted-web/panel/entry.mjs',
      ],
    }, 'ui_artifact_manifest_missing'],
    ['wrong tier', { artifactTier: 'hostedWeb' as const }, 'ui_artifact_identity_mismatch'],
  ])('rejects a Voice client artifact with %s', async (_case, overrides, code) => {
    const fixture = await createCandidateFixture({
      includeUiRenderer: false,
      includeVoiceProvider: true,
      artifactContributionId: 'voice-runtime-web',
      artifactTier: 'reactNative',
      ...overrides,
    });

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({ ok: false, rejection: { code } });
  });

  it('validates exact npm, package, manifest, executable, and generated-UI identities without running package code', async () => {
    const fixture = await createCandidateFixture();

    const result = await stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    });

    expect(result).toMatchObject({
      ok: true,
      candidate: {
        source: fixture.candidate.source,
        package: { name: '@acme/happier-plugin', version: '1.2.3' },
        manifest: { id: 'acme.npm-stage', version: '1.2.3' },
        generatedUiArtifacts: { contributionIds: ['panel-web'] },
        registrySignature: fixture.candidate.registrySignature,
        provenance: fixture.candidate.provenance,
      },
    });
    if (!result.ok) throw new Error('Expected candidate to stage');
    expect(result.candidate).not.toHaveProperty('rootDigest');
    expect(result.candidate.inventory.some((file) => file.path === 'dist/daemon.mjs')).toBe(true);
    const manifestInventoryFile = result.candidate.inventory.find((file) => file.path === '.happier-plugin/plugin.json');
    expect(manifestInventoryFile?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.candidate.manifest.digest).toBe(manifestInventoryFile?.digest);
    await expect(readFile(fixture.sideEffectPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(fixture.candidate.artifactPath)).resolves.toBeInstanceOf(Buffer);

    await cleanupStagedNpmArtifactCandidate(result.candidate);
    await expect(readFile(join(result.candidate.rootPath, 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(fixture.candidate.artifactPath)).resolves.toBeInstanceOf(Buffer);
  });

  it.each([
    ['package name', { packageName: '@acme/wrong' }, 'package_identity_mismatch'],
    ['package version', { packageVersion: '9.9.9' }, 'package_identity_mismatch'],
    ['package manifest convention', { packageManifestPath: 'plugin.json' }, 'package_contract_invalid'],
    ['package keyword', { packageKeywords: ['other'] }, 'package_contract_invalid'],
    ['missing selected-file inventory', { extraPackageJson: { files: undefined } }, 'package_contract_invalid'],
    ['non-portable selected-file inventory', { packageFiles: ['dist', '../outside'] }, 'package_contract_invalid'],
    ['stale selected-file inventory', { packageFiles: ['.happier-plugin', 'dist', 'missing'] }, 'package_contract_invalid'],
    ['manifest version', { manifestVersion: '9.9.9' }, 'manifest_identity_mismatch'],
    ['generated artifact identity', { artifactContributionId: 'other' }, 'ui_artifact_identity_mismatch'],
    ['generated artifact tier', { artifactTier: 'reactNative' }, 'ui_artifact_identity_mismatch'],
    ['generated artifact digest', { artifactDigest: `sha256:${'a'.repeat(64)}` }, 'ui_artifact_digest_mismatch'],
  ] satisfies readonly [string, FixtureOverrides, string][])('rejects %s drift with a typed result and removes the incomplete stage', async (_case, overrides, code) => {
    const fixture = await createCandidateFixture(overrides);
    await mkdir(fixture.stagingParentPath, { recursive: true });
    const siblingPath = join(fixture.stagingParentPath, 'owned-by-another-operation');
    await writeFile(siblingPath, 'preserve');

    const result = await stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    });

    expect(result).toMatchObject({ ok: false, rejection: { code } });
    expect(await readFile(siblingPath, 'utf8')).toBe('preserve');
    await expect(readFile(fixture.candidate.artifactPath)).resolves.toBeInstanceOf(Buffer);
  });

  it('rejects dependency trees accidentally shipped inside the portable plugin artifact', async () => {
    const fixture = await createCandidateFixture({
      extraEntries: [{
        name: 'package/node_modules/should-never-be-shipped/index.js',
        body: 'module.exports = true;\n',
      }],
    });

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({ ok: false, rejection: { code: 'package_contract_invalid' } });
  });

  it('rejects files that are present in the package but absent from its selected-file inventory', async () => {
    const fixture = await createCandidateFixture({
      extraEntries: [{ name: 'package/undeclared.txt', body: 'not selected\n' }],
    });

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({ ok: false, rejection: { code: 'package_contract_invalid' } });
  });

  it('rejects a published executable that only supplies a development entrypoint', async () => {
    const fixture = await createCandidateFixture({
      extraEntries: [],
    });
    const bytes = await createTestNpmTarball([
      {
        name: 'package/package.json',
        body: JSON.stringify({
          name: '@acme/happier-plugin', version: '1.2.3', keywords: ['happier-plugin'],
          files: ['.happier-plugin', 'src'],
          happier: { manifest: '.happier-plugin/plugin.json' },
        }),
      },
      {
        name: 'package/.happier-plugin/plugin.json',
        body: JSON.stringify({
          schemaVersion: 2, id: 'acme.npm-stage', version: '1.2.3', displayName: 'Acme',
          description: 'Development-only published fixture', engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
          entrypoints: { development: './src/daemon.ts' }, contributes: {},
        }),
      },
      { name: 'package/src/daemon.ts', body: 'export function activate() {}' },
    ]);
    await writeFile(fixture.candidate.artifactPath, bytes);
    const candidate = {
      ...fixture.candidate,
      byteLength: bytes.byteLength,
      archiveDigestSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      source: { ...fixture.candidate.source, integrity: sriSha512(bytes) },
    } satisfies DownloadedNpmArtifactCandidate;

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({ ok: false, rejection: { code: 'published_entrypoint_invalid' } });
  });

  it('stages a schema-valid plugin manifest whose declarative content exceeds a mebibyte', async () => {
    // First-party plugins already publish manifests well past a mebibyte of
    // honest declarative content: the generated Channels manifest is ~1.48 MiB
    // of `contributes` plus localized strings. Manifest bytes therefore carry
    // no ceiling of their own. Strict UTF-8 decoding, JSON parsing, schema and
    // semantic validation, and the depth-bounded traversal guard are owned by
    // manifest ingestion; per-file and aggregate expansion bounds are owned by
    // the archive. `package.json` and `ui-artifacts.json` keep the retained
    // control-artifact metadata bound because they stay small by construction.
    const resources = Array.from({ length: 3_000 }, (_, index) => ({
      id: `generated-resource-${index}`,
      source: 'dynamic',
      kind: 'prompt',
      contentType: 'text/markdown',
      metadata: {
        title: `Generated conversation resource ${index}`,
        summary: `Declarative contribution ${index} standing in for the localized`
          + ` contribution content that makes a real first-party manifest large.`,
      },
    }));
    const pluginManifestBody = JSON.stringify({
      schemaVersion: 2,
      id: 'acme.npm-stage',
      version: '1.2.3',
      displayName: 'Acme npm stage',
      description: 'Large declarative candidate staging fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/daemon.mjs' },
      contributes: { resources },
    }, null, 2);
    expect(Buffer.byteLength(pluginManifestBody, 'utf8')).toBeGreaterThan(1024 * 1024);
    const fixture = await createCandidateFixture({
      includeUiRenderer: false,
      pluginManifestBody,
      omitPaths: [
        'package/dist/happier-plugin-ui/ui-artifacts.json',
        'package/dist/happier-plugin-ui/hosted-web/panel/entry.mjs',
      ],
    });

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({ ok: true });
  });

  it('still rejects a control artifact that exceeds the retained metadata byte bound', async () => {
    // Dropping the manifest ceiling was surgical. `package.json` and
    // `ui-artifacts.json` are small-by-construction control artifacts that the
    // staging reader parses before anything else has validated them, so they
    // keep the bounded-read metadata limit the manifest no longer carries.
    // High-entropy padding: compressible filler would trip the archive's
    // compression-ratio guard first and this test would stop discriminating.
    const fixture = await createCandidateFixture({
      extraPackageJson: { padding: randomBytes(600 * 1024).toString('hex') },
    });

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({ ok: false, rejection: { code: 'package_json_invalid' } });
  });

  it('accepts unrelated future package happier metadata while keeping manifest ownership exact', async () => {
    const fixture = await createCandidateFixture({
      extraPackageJson: { happier: { manifest: '.happier-plugin/plugin.json', futureMetadata: true } },
    });

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({ ok: true });
  });

  it('rejects generated UI files that are not claimed by the reviewed artifact inventory', async () => {
    const fixture = await createCandidateFixture({
      extraEntries: [{ name: 'package/dist/happier-plugin-ui/unclaimed.js', body: 'unexpected' }],
    });

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({ ok: false, rejection: { code: 'ui_artifact_identity_mismatch' } });
  });

  it('rejects generated UI files when no renderer or artifact manifest claims them', async () => {
    const fixture = await createCandidateFixture({
      includeUiRenderer: false,
      omitPaths: [
        'package/dist/happier-plugin-ui/ui-artifacts.json',
        'package/dist/happier-plugin-ui/hosted-web/panel/entry.mjs',
      ],
      extraEntries: [{ name: 'package/dist/happier-plugin-ui/unclaimed.js', body: 'unexpected' }],
    });

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({ ok: false, rejection: { code: 'ui_artifact_identity_mismatch' } });
  });

  it('rejects duplicate generated artifact slots even when they claim disjoint valid files', async () => {
    const fixture = await createCandidateFixture({ duplicateArtifactSlot: true });

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({ ok: false, rejection: { code: 'ui_artifact_identity_mismatch' } });
  });

  it('bounds attacker-controlled generated artifact paths in typed rejections', async () => {
    const attackerPath = `${'attacker-controlled/'.repeat(700)}missing.mjs`;
    const fixture = await createCandidateFixture({ artifactEntryPath: attackerPath });

    const result = await stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    });

    expect(result).toMatchObject({ ok: false, rejection: { code: 'ui_artifact_file_missing' } });
    if (result.ok) throw new Error('Expected candidate rejection');
    expect(result.rejection.message.length).toBeLessThan(512);
    expect(result.rejection.message).not.toContain(attackerPath);
  });

  it('rejects missing declared daemon and generated artifact files', async () => {
    for (const [omittedPath, expectedCode] of [
      ['package/dist/daemon.mjs', 'declared_file_missing'],
      ['package/dist/happier-plugin-ui/hosted-web/panel/entry.mjs', 'ui_artifact_file_missing'],
    ] as const) {
      const fixture = await createCandidateFixture({ omitPaths: [omittedPath] });
      await expect(stageDownloadedNpmArtifactCandidate({
        candidate: fixture.candidate,
        stagingParentPath: fixture.stagingParentPath,
      })).resolves.toMatchObject({ ok: false, rejection: { code: expectedCode } });
    }
  });

  it('rejects interrupted work without publishing state or deleting pre-existing paths', async () => {
    const fixture = await createCandidateFixture();
    await mkdir(fixture.stagingParentPath, { recursive: true });
    const siblingPath = join(fixture.stagingParentPath, 'preserve');
    await writeFile(siblingPath, 'sibling');
    const controller = new AbortController();
    controller.abort(new Error('cancel staging'));

    const result = await stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ ok: false, rejection: { code: 'staging_aborted' } });
    expect(await readFile(siblingPath, 'utf8')).toBe('sibling');
    await expect(readFile(fixture.candidate.artifactPath)).resolves.toBeInstanceOf(Buffer);
  });

  it('honors cancellation that arrives after extraction and before candidate validation', async () => {
    const fixture = await createCandidateFixture();
    const controller = new AbortController();
    const removeEventListener = controller.signal.removeEventListener.bind(controller.signal);
    Object.defineProperty(controller.signal, 'removeEventListener', {
      configurable: true,
      value: (...args: Parameters<AbortSignal['removeEventListener']>) => {
        removeEventListener(...args);
        controller.abort(new Error('cancel after extraction'));
      },
    });

    const result = await stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ ok: false, rejection: { code: 'staging_aborted' } });
  });

  it('retains the exact per-file manifest digest without publishing aggregate tree or package JSON digest fields', async () => {
    const firstFixture = await createCandidateFixture();
    const secondFixture = await createCandidateFixture({
      packageFiles: ['.happier-plugin', 'dist', 'NOTICE'],
      extraEntries: [{ name: 'package/NOTICE', body: 'extra' }],
    });

    const first = await stageDownloadedNpmArtifactCandidate({ candidate: firstFixture.candidate, stagingParentPath: firstFixture.stagingParentPath });
    const second = await stageDownloadedNpmArtifactCandidate({ candidate: secondFixture.candidate, stagingParentPath: secondFixture.stagingParentPath });
    if (!first.ok || !second.ok) throw new Error('Expected both fixtures to stage');

    expect(first.candidate).not.toHaveProperty('rootDigest');
    expect(second.candidate).not.toHaveProperty('rootDigest');
    const firstManifestFile = first.candidate.inventory.find((file) => file.path === '.happier-plugin/plugin.json');
    const secondManifestFile = second.candidate.inventory.find((file) => file.path === '.happier-plugin/plugin.json');
    expect(first.candidate.manifest.digest).toBe(firstManifestFile?.digest);
    expect(second.candidate.manifest.digest).toBe(secondManifestFile?.digest);
    expect(firstManifestFile?.digest).toBe(secondManifestFile?.digest);
    expect(first.candidate).not.toHaveProperty('packageJsonDigest');
    expect(second.candidate).not.toHaveProperty('packageJsonDigest');
  });

  it('refuses cleanup requests that do not identify an operation-owned staging root', async () => {
    const fixture = await createCandidateFixture();
    const staged = await stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    });
    if (!staged.ok) throw new Error('Expected fixture to stage');
    const victimRoot = join(fixture.root, 'victim', 'root');
    await mkdir(victimRoot, { recursive: true });
    const markerPath = join(victimRoot, 'marker');
    await writeFile(markerPath, 'preserve');

    await expect(cleanupStagedNpmArtifactCandidate({
      ...staged.candidate,
      rootPath: victimRoot,
    })).rejects.toThrow(/operation-owned/i);
    expect(await readFile(markerPath, 'utf8')).toBe('preserve');
    await cleanupStagedNpmArtifactCandidate(staged.candidate);
  });

  it('joins concurrent cleanup callers for the same operation-owned staged candidate', async () => {
    const fixture = await createCandidateFixture();
    const staged = await stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
    });
    if (!staged.ok) throw new Error('Expected fixture to stage');

    await expect(Promise.all([
      cleanupStagedNpmArtifactCandidate(staged.candidate),
      cleanupStagedNpmArtifactCandidate(staged.candidate),
    ])).resolves.toEqual([undefined, undefined]);
  });
});
