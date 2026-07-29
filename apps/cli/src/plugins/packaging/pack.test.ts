import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as tar from 'tar';
import { describe, expect, it } from 'vitest';

import { resolveJavaScriptRuntimeExecutable } from '@/packagedRuntime/js/resolveJavaScriptRuntimeExecutable';
import { readGeneratedPluginUiArtifactsManifest } from '@/plugins/install/ui/generatedArtifacts';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';

import { bundlePluginDaemonRuntime } from '../authoring/bundleDaemonRuntime';
import {
  cleanupStagedNpmArtifactCandidate,
  stageDownloadedNpmArtifactCandidate,
} from '../distribution/npm/stage';
import { sriSha512 } from '../distribution/testkit/npmTarball';
import { scaffoldLocalPlugin } from '../scaffold/scaffold';
import { packLocalPlugin } from './pack';

const execFileAsync = promisify(execFile);

async function writeSelectedPackage(root: string): Promise<void> {
  const scaffold = await scaffoldLocalPlugin({
    targetDir: root,
    pluginId: 'acme.selected-plugin',
    displayName: 'Selected Plugin',
    pluginSdkVersion: '0.1.0-wave1.fixture',
  });
  if (!scaffold.ok) {
    throw new Error(scaffold.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
  }
  await bundlePluginDaemonRuntime(root);
  await writeFile(join(root, 'private-token.txt'), 'must-not-ship\n', 'utf8');
}

async function writeManagedRuntimeFixture(homeDir: string): Promise<string> {
  const binDir = join(homeDir, 'tools', 'js-runtime', 'current', 'bin');
  const runtimeDir = join(homeDir, 'tools', 'js-runtime', 'current', 'runtime');
  const wrapperPath = join(binDir, process.platform === 'win32' ? 'happier-js-runtime.cmd' : 'happier-js-runtime');
  const runtimePath = process.platform === 'win32'
    ? join(runtimeDir, 'node.exe')
    : join(runtimeDir, 'bin', 'node');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(runtimePath, '..'), { recursive: true });
  if (process.platform === 'win32') {
    await copyFile(process.execPath, runtimePath);
    await writeFile(wrapperPath, '@echo off\r\n"%~dp0..\\runtime\\node.exe" %*\r\n', 'utf8');
  } else {
    await symlink(process.execPath, runtimePath);
    await writeFile(wrapperPath, '#!/bin/sh\nexec "${0%/*}/../runtime/bin/node" "$@"\n', 'utf8');
    await chmod(wrapperPath, 0o755);
  }
  return wrapperPath;
}

describe('packLocalPlugin', () => {
  it('packs a dependency-closed external Voice provider that calls the public activate(api) ABI', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-packed-voice-'));
    const archivePath = join(parent, 'packed-voice.tgz');
    const installRoot = join(parent, 'installed');
    const fixtureRoot = fileURLToPath(new URL('../testkit/fixtures/packed-external-voice-provider', import.meta.url));
    let staged: Awaited<ReturnType<typeof stageDownloadedNpmArtifactCandidate>> | null = null;
    try {
      const packed = await packLocalPlugin({ locator: fixtureRoot, outPath: archivePath });
      expect(packed, packed.ok ? '' : packed.diagnostics.map((entry) => entry.message).join('\n')).toMatchObject({ ok: true });
      if (!packed.ok) return;
      const archiveBytes = await readFile(archivePath);
      await mkdir(installRoot);
      staged = await stageDownloadedNpmArtifactCandidate({
        candidate: {
          source: {
            kind: 'npm', registryOrigin: 'https://packed-voice.invalid',
            packageName: 'happier-plugin-acme-packed-voice', version: '1.0.0',
            integrity: sriSha512(archiveBytes), tarballUrl: pathToFileURL(archivePath).href,
          },
          artifactPath: archivePath,
          byteLength: archiveBytes.byteLength,
          registrySignature: { status: 'absent' },
          provenance: { status: 'absent' },
        },
        stagingParentPath: installRoot,
      });
      expect(staged.ok).toBe(true);
      if (!staged.ok) return;
      expect(staged.candidate.generatedUiArtifacts.contributionIds).toEqual(['voice-runtime-web']);
      const generatedUiArtifactsManifest = await readGeneratedPluginUiArtifactsManifest(staged.candidate.rootPath);
      expect(generatedUiArtifactsManifest?.entries).toHaveLength(1);
      const resolved = createResolvedContributionRegistry(projectLoadedPluginContributes({
        loadResult: {
          loadedPlugins: [{
            pluginId: staged.candidate.manifest.id,
            pluginRootPath: staged.candidate.rootPath,
            manifestPath: join(staged.candidate.rootPath, '.happier-plugin', 'plugin.json'),
            manifestDigest: staged.candidate.manifest.digest,
            daemonEntryPath: join(staged.candidate.rootPath, 'dist', 'daemon.js'),
            devDaemonEntryPath: null,
            ...(generatedUiArtifactsManifest ? { generatedUiArtifactsManifest } : {}),
            manifest: staged.candidate.manifest.value,
            sourceSpec: {
              kind: 'path', locator: staged.candidate.rootPath,
              trustPolicy: 'local_trusted', installPolicy: 'link',
            },
          }],
          diagnosticsByPluginId: { [staged.candidate.manifest.id]: [] },
        },
        provenance: 'external',
      }));
      const projection = buildPluginProjectionV2({
        registry: resolved,
        generation: 7,
        pluginUiHostRuntime: {
          reactNativeBundles: {
            featureEnabled: true,
            loaderBackendAvailable: true,
            hostRuntime: {
              platform: 'web', channel: 'internal', hostAppVersion: '0.2.10',
              hostUiApiVersion: '1.0.0', reactVersion: '19.2.0', reactNativeVersion: '0.83.4',
              availableNativeCapabilities: [],
            },
          },
        },
      });
      const packedVoiceProjection =
        projection.familiesById.voiceProviders?.entriesById['acme.packed-voice/conversation'];
      expect(packedVoiceProjection).toMatchObject({
        definition: { client: { artifactId: 'voice-runtime-web' } },
        recipientContract: {
          credentialSlot: { id: 'api_key', scope: 'account' },
          operations: expect.arrayContaining([
            expect.objectContaining({ id: 'list-voices', effect: 'read' }),
            expect.objectContaining({ id: 'provision-voice', effect: 'mutation' }),
            expect.objectContaining({ id: 'client-auth', effect: 'read' }),
          ]),
        },
        recipientContractDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      });
      expect(projection.familiesById.pluginUi?.entriesById['reactNativeBundle:acme.packed-voice:conversation'])
        .toMatchObject({
          artifactGraph: { contributionId: 'voice-runtime-web', platform: 'web' },
          runtime: {
            decision: { state: 'load' },
            loadPolicy: { source: 'installedArtifact' },
            cacheIdentity: { pluginId: 'acme.packed-voice', contributionId: 'conversation', projectionGeneration: 7 },
          },
        });
      expect(staged.candidate.manifest.value.entrypoints).toEqual({
        daemon: './dist/daemon.js',
      });
      expect(staged.candidate.inventory.some((entry) => entry.path === 'dist/daemon.js')).toBe(true);
      expect(staged.candidate.manifest.value.contributes.actions).toEqual([]);
      expect(staged.candidate.manifest.value.contributes.tools).toEqual([]);
      expect(staged.candidate.manifest.value.contributes.commands).toEqual([]);
      expect(staged.candidate.manifest.value.contributes.ui).toEqual({
        views: [],
        renderers: [],
        translations: [],
      });
      expect(staged.candidate.manifest.value.contributes.voiceProviders[0])
        .toMatchObject({
          platforms: ['web'],
          settings: {
            schemaVersion: 2,
            fields: [
              expect.objectContaining({
                id: 'profile',
                default: 'balanced',
                presentation: expect.objectContaining({ control: 'select' }),
              }),
              expect.objectContaining({
                id: 'enableProvisioning',
                default: true,
                presentation: expect.objectContaining({ control: 'switch' }),
              }),
            ],
          },
          accountMediation: {
            operations: [
              expect.objectContaining({
                id: 'list-voices',
                purpose: 'voice.catalog.voices',
                effect: 'read',
                request: expect.objectContaining({
                  origin: 'https://voice.example.test',
                  pathTemplate: '/v1/voices',
                  method: 'GET',
                }),
              }),
              expect.objectContaining({
                id: 'provision-voice',
                purpose: 'voice.provision.selected',
                effect: 'mutation',
                request: expect.objectContaining({
                  origin: 'https://voice.example.test',
                  pathTemplate: '/v1/voices/{voiceId}',
                  method: 'PATCH',
                }),
              }),
              expect.objectContaining({
                id: 'client-auth',
                purpose: 'voice.client-auth',
                effect: 'read',
                request: expect.objectContaining({
                  origin: 'https://voice.example.test',
                  pathTemplate: '/v1/session',
                  method: 'POST',
                }),
              }),
            ],
          },
        });
    } finally {
      if (staged?.ok) await cleanupStagedNpmArtifactCandidate(staged.candidate).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('creates one npm-compatible selected-file artifact and validates it through canonical staging', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-selected-pack-'));
    const root = join(parent, 'plugin');
    const archivePath = join(parent, 'selected-plugin.tgz');
    await writeSelectedPackage(root);

    try {
      const result = await packLocalPlugin({ locator: root, outPath: archivePath });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const entries: string[] = [];
      await tar.t({
        file: archivePath,
        onentry(entry) {
          entries.push(entry.path);
        },
      });
      expect(entries).toContain('package/package.json');
      expect(entries).toContain('package/.happier-plugin/plugin.json');
      expect(entries).toContain('package/dist/index.js');
      expect(entries).not.toContain('package/src/index.ts');
      expect(entries).not.toContain('package/private-token.txt');
      expect(await readFile(`${archivePath}.sha256`, 'utf8')).toMatch(/^sha256:[a-f0-9]{64}  selected-plugin\.tgz\n$/u);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('stages without lifecycle scripts and runs the self-contained artifact through the binary-safe runtime with an empty PATH', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-self-contained-pack-'));
    const root = join(parent, 'plugin');
    const archivePath = join(parent, 'selected-plugin.tgz');
    const lifecycleMarker = 'lifecycle-script-ran.txt';
    let staged: Awaited<ReturnType<typeof stageDownloadedNpmArtifactCandidate>> | null = null;

    try {
      await writeSelectedPackage(root);
      const dependencyRoot = join(root, 'node_modules', 'fixture-runtime-dependency');
      await mkdir(dependencyRoot, { recursive: true });
      await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({
        name: 'fixture-runtime-dependency',
        version: '1.0.0',
        type: 'module',
        exports: './index.js',
      }), 'utf8');
      await writeFile(join(dependencyRoot, 'index.js'), "export const suffix = 'bundled-runtime-dependency';\n", 'utf8');
      await writeFile(join(root, 'src', 'index.ts'), [
        "import { suffix } from 'fixture-runtime-dependency';",
        "import type { PluginApi } from '@happier-dev/plugin-sdk';",
        "import type { ActionHandler } from '@happier-dev/plugin-sdk/runtime';",
        '',
        'export const saveNote: ActionHandler = async (input) => {',
        "  const note = typeof input === 'object' && input !== null && 'note' in input",
        "    && typeof input.note === 'string' ? input.note : '';",
        '  return { note: `${note}:${suffix}` };',
        '};',
        '',
        'export function activate(api: PluginApi): void {',
        "  api.actions.register('save-note', saveNote);",
        '}',
        '',
      ].join('\n'), 'utf8');
      const packageJsonPath = join(root, 'package.json');
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<string, unknown>;
      packageJson.scripts = {
        ...(packageJson.scripts as Record<string, string>),
        postinstall: `node -e "require('node:fs').writeFileSync('${lifecycleMarker}', 'ran')"`,
      };
      packageJson.dependencies = {
        ...(packageJson.dependencies as Record<string, string>),
        'fixture-runtime-dependency': '1.0.0',
      };
      await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8');
      await bundlePluginDaemonRuntime(root);
      await rm(join(root, 'node_modules'), { recursive: true, force: true });

      const packed = await packLocalPlugin({ locator: root, outPath: archivePath });
      expect(packed.ok).toBe(true);
      if (!packed.ok) return;
      const archiveBytes = await readFile(archivePath);
      const stagingParentPath = join(parent, 'installed');
      await mkdir(stagingParentPath);
      staged = await stageDownloadedNpmArtifactCandidate({
        candidate: {
          source: {
            kind: 'npm',
            registryOrigin: 'https://qa-008.invalid',
            packageName: 'happier-plugin-acme-selected-plugin',
            version: '0.1.0',
            integrity: sriSha512(archiveBytes),
            tarballUrl: pathToFileURL(archivePath).href,
          },
          artifactPath: archivePath,
          byteLength: archiveBytes.byteLength,
          registrySignature: { status: 'absent' },
          provenance: { status: 'absent' },
        },
        stagingParentPath,
      });
      expect(staged.ok).toBe(true);
      if (!staged.ok) return;

      await rm(root, { recursive: true, force: true });
      expect(await readFile(join(staged.candidate.rootPath, 'package.json'), 'utf8')).toContain('postinstall');
      expect(staged.candidate.inventory.some((file) => file.path.startsWith('node_modules/'))).toBe(false);
      await expect(readFile(join(staged.candidate.rootPath, lifecycleMarker), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(staged.candidate.rootPath, 'node_modules', 'fixture-runtime-dependency', 'index.js'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });

      const managedHome = join(parent, 'managed-home');
      const expectedRuntime = await writeManagedRuntimeFixture(managedHome);
      const runtimeEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HAPPIER_HOME_DIR: managedHome,
        PATH: '',
      };
      delete runtimeEnv.HAPPIER_JS_RUNTIME_PATH;
      delete runtimeEnv.HAPPIER_MANAGED_NODE_BIN;
      delete runtimeEnv.HAPPIER_NODE_PATH;
      const runtime = resolveJavaScriptRuntimeExecutable({
        isBunRuntime: true,
        currentExecPath: join(parent, 'self-contained-happier'),
        processEnv: runtimeEnv,
      });
      expect(runtime).toBe(expectedRuntime);

      const entrypointUrl = pathToFileURL(join(staged.candidate.rootPath, 'dist', 'index.js')).href;
      const probe = [
        `const mod = await import(${JSON.stringify(entrypointUrl)});`,
        'let action;',
        "await mod.activate({ actions: { register(id, handler) { if (id === 'save-note') action = handler; } } });",
        "if (typeof action !== 'function') throw new Error('packed action was not registered');",
        "const result = await action({ note: 'qa-008' });",
        "if (result?.note !== 'qa-008:bundled-runtime-dependency') throw new Error('runtime dependency closure was not bundled');",
      ].join('\n');
      const execution = await execFileAsync(runtime!, ['--input-type=module', '--eval', probe], {
        cwd: staged.candidate.rootPath,
        env: runtimeEnv,
      });
      expect(execution.stderr).toBe('');
    } finally {
      if (staged?.ok) await cleanupStagedNpmArtifactCandidate(staged.candidate).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects package metadata that cannot describe the canonical npm artifact contract', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-invalid-pack-'));
    const root = join(parent, 'plugin');
    await writeSelectedPackage(root);
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    delete packageJson.files;
    await writeFile(join(root, 'package.json'), JSON.stringify(packageJson), 'utf8');

    try {
      const result = await packLocalPlugin({ locator: root, outPath: join(parent, 'invalid.tgz') });
      expect(result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ message: expect.stringContaining('files') })],
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects a directly selected file reached through a symbolic-link ancestor', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-symlink-pack-'));
    const root = join(parent, 'plugin');
    const outside = join(parent, 'outside');
    await writeSelectedPackage(root);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.js'), 'export const secret = true;\n', 'utf8');
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    packageJson.files = ['.happier-plugin', 'dist', 'linked/secret.js'];
    await writeFile(join(root, 'package.json'), JSON.stringify(packageJson), 'utf8');

    try {
      const result = await packLocalPlugin({ locator: root, outPath: join(parent, 'invalid.tgz') });
      expect(result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ message: expect.stringContaining('symbolic link') })],
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects an output path that physically resolves inside the plugin package root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-output-symlink-pack-'));
    const root = join(parent, 'plugin');
    const rootAlias = join(parent, 'plugin-alias');
    await writeSelectedPackage(root);
    await symlink(root, rootAlias, process.platform === 'win32' ? 'junction' : 'dir');

    try {
      const result = await packLocalPlugin({
        locator: root,
        outPath: join(rootAlias, 'invalid.tgz'),
      });
      expect(result).toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({
          message: 'Plugin pack output must be outside the plugin package root',
        })],
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
