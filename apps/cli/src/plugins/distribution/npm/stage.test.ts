import { createHash } from 'node:crypto';
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
  duplicateArtifactSlot?: boolean;
  extraPackageJson?: Readonly<Record<string, unknown>>;
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
    files: overrides.packageFiles ?? ['.happier-plugin', 'dist'],
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
      voiceProviders: overrides.includeVoiceProvider ? [{
        id: 'conversation',
        title: 'Conversation',
        kind: 'conversation',
        roles: ['realtime_conversation', 'turn_control'],
        platforms: overrides.voiceProviderPlatforms ?? ['web'],
        capabilities: {
          readiness: { requirements: [] },
          turn: { cancelResponse: true, bargeIn: false },
        },
        client: {
          artifactId: 'voice-runtime-web',
          modulePath: './voiceRuntime',
          exportName: 'activate',
        },
      }] : [],
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
        compat: {
          react: '19.2.0',
          ...(overrides.artifactTier === 'reactNative' ? { reactNative: '0.83.4' } : {}),
        },
      },
      ...((overrides.additionalVoiceArtifactPlatforms ?? []).map((platform) => {
        const relativePath = `react-native/voice-runtime-web/${platform}.bundle.js`;
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
            modulePath: './voiceRuntime',
            exportName: 'activate',
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
        compat: {
          react: '19.2.0',
          ...(overrides.artifactTier === 'reactNative' ? { reactNative: '0.83.4' } : {}),
        },
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
      name: `package/dist/happier-plugin-ui/react-native/voice-runtime-web/${platform}.bundle.js`,
      body: `export function activate() { /* ${platform} */ }\n`,
    }))),
    ...(overrides.duplicateArtifactSlot
      ? [{ name: `package/dist/happier-plugin-ui/${duplicateUiEntryPath}`, body: duplicateUiBytes }]
      : []),
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
    expect(result.candidate.rootDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.candidate.inventory.some((file) => file.path === 'dist/daemon.mjs')).toBe(true);
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
      source: { ...fixture.candidate.source, integrity: sriSha512(bytes) },
    } satisfies DownloadedNpmArtifactCandidate;

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate,
      stagingParentPath: fixture.stagingParentPath,
    })).resolves.toMatchObject({ ok: false, rejection: { code: 'published_entrypoint_invalid' } });
  });

  it('rejects a plugin manifest above the bounded metadata limit before parsing it', async () => {
    const validManifest = JSON.stringify({
      schemaVersion: 2,
      id: 'acme.npm-stage',
      version: '1.2.3',
      displayName: 'Acme npm stage',
      description: 'Oversized candidate staging fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/daemon.mjs' },
      contributes: {},
    });
    const fixture = await createCandidateFixture({
      includeUiRenderer: false,
      pluginManifestBody: `${' '.repeat(1024 * 1024)}${validManifest}`,
      omitPaths: [
        'package/dist/happier-plugin-ui/ui-artifacts.json',
        'package/dist/happier-plugin-ui/hosted-web/panel/entry.mjs',
      ],
    });

    await expect(stageDownloadedNpmArtifactCandidate({
      candidate: fixture.candidate,
      stagingParentPath: fixture.stagingParentPath,
      archiveLimits: { maxCompressionRatio: 10_000 },
    })).resolves.toMatchObject({ ok: false, rejection: { code: 'manifest_invalid' } });
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

  it('binds the canonical root digest to exact package and inventory bytes', async () => {
    const firstFixture = await createCandidateFixture();
    const secondFixture = await createCandidateFixture({
      packageFiles: ['.happier-plugin', 'dist', 'NOTICE'],
      extraEntries: [{ name: 'package/NOTICE', body: 'extra' }],
    });

    const first = await stageDownloadedNpmArtifactCandidate({ candidate: firstFixture.candidate, stagingParentPath: firstFixture.stagingParentPath });
    const second = await stageDownloadedNpmArtifactCandidate({ candidate: secondFixture.candidate, stagingParentPath: secondFixture.stagingParentPath });
    if (!first.ok || !second.ok) throw new Error('Expected both fixtures to stage');

    expect(first.candidate.rootDigest).not.toBe(second.candidate.rootDigest);
    expect(first.candidate.packageJsonDigest).toBe(`sha256:${createHash('sha256').update(await readFile(join(first.candidate.rootPath, 'package.json'))).digest('hex')}`);
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
