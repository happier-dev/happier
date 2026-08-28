import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PLUGIN_UI_ARTIFACT_GRAMMAR_VERSION_V1,
  PluginUiArtifactsManifestV1Schema,
  computePluginUiArtifactFileSetSha256DigestV1,
  computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  CurrentManagedStackPluginUiAttestation,
  CurrentManagedStackPluginUiContext,
  CurrentManagedStackSourcePluginGeneration,
} from './currentManagedStackPluginUiQa';

const roots: Array<string> = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

const HOSTED_ARTIFACT_ID = 'examples.production-hosted-reference/dashboard';
const GENERATION = 'generation-7';
const FILE_BYTES = new TextEncoder().encode('<html><body>current-source hosted artifact</body></html>');

async function writeCurrentSourcePluginRoot(): Promise<string> {
  const pluginRoot = await mkdtemp(join(tmpdir(), 'hosted-artifact-qa-plugin-'));
  roots.push(pluginRoot);
  const artifactDir = join(pluginRoot, 'dist', 'happier-plugin-ui');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, 'index.html'), FILE_BYTES);
  const entryDigest = computePluginUiArtifactFileSetSha256DigestV1([Object.freeze({
    relativePath: 'index.html',
    bytes: FILE_BYTES,
  })]);
  const manifest = PluginUiArtifactsManifestV1Schema.parse({
    version: PLUGIN_UI_ARTIFACT_GRAMMAR_VERSION_V1,
    entries: [{
      contributionId: HOSTED_ARTIFACT_ID,
      tier: 'hostedWeb',
      entry: 'index.html',
      files: [{
        relativePath: 'index.html',
        digest: computePluginUiArtifactSha256DigestV1(FILE_BYTES),
        byteSize: FILE_BYTES.byteLength,
      }],
      digest: entryDigest,
      builtWith: { bundler: 'vite', version: '0.0.0-test' },
      hostUiApiVersion: 'v1',
      compat: {},
    }],
  });
  await writeFile(join(artifactDir, 'ui-artifacts.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return pluginRoot;
}

const fakeContext: CurrentManagedStackPluginUiContext = {
  runtimeJsonPath: '/tmp/qa-stack/qa-stack.runtime.json',
  stackDir: '/tmp/qa-stack',
  stackName: 'qa-stack',
  cliHome: '/tmp/qa-stack/cli-home',
  uiUrl: 'http://127.0.0.1:8081',
  serverUrl: 'http://127.0.0.1:3005',
  account: {
    accountId: 'account-1',
    serverId: 'server-a',
    serverIdentityId: null,
    uiServerId: 'server-a-ui',
  },
  daemon: {
    pid: 4242,
    port: 4919,
    controlToken: 'token-1',
    statePath: '/tmp/qa-stack/daemon.state.json',
    runtimeId: 'runtime-1',
    machineId: 'machine-a',
    runtimeEntrypoint: 'apps/cli/dist/happier.mjs',
    distClosureFingerprint: null,
  },
  runtime: {
    updatedAt: null,
    runtimeSnapshotId: null,
    selectedSnapshotId: 'snapshot-1',
    pendingManualRestart: false,
    publicationComponents: {},
  },
  uiProducer: {
    mode: 'snapshot',
    stackName: 'qa-stack',
    runtimeJsonPath: '/tmp/qa-stack/qa-stack.runtime.json',
    projectDir: null,
    pid: null,
    processInstanceFingerprint: null,
  },
  authStorage: { localStorage: {}, sessionStorage: {} },
};

const fakeAttestation: CurrentManagedStackPluginUiAttestation = {
  stackName: fakeContext.stackName,
  runtimeJsonPath: fakeContext.runtimeJsonPath,
  runtimeUpdatedAt: null,
  runtimeSnapshotId: null,
  selectedSnapshotId: 'snapshot-1',
  pendingManualRestart: false,
  uiProducer: fakeContext.uiProducer,
  daemonPid: fakeContext.daemon.pid,
  daemonRuntimeId: fakeContext.daemon.runtimeId,
  daemonMachineId: fakeContext.daemon.machineId,
  daemonRuntimeEntrypoint: fakeContext.daemon.runtimeEntrypoint,
  daemonDistClosureFingerprint: null,
  daemonPingVerified: true,
  accountId: fakeContext.account.accountId,
  serverId: fakeContext.account.serverId,
  serverIdentityId: null,
  pluginId: 'happier.inspector',
  desiredGeneration: GENERATION,
  appliedGeneration: GENERATION,
  contributionProjectionGeneration: 'projection-1',
  artifact: { platform: 'web', digest: 'sha256:0'.padEnd(71, '0'), entry: 'index.html', byteSize: 1 },
};

const fakeGeneration: CurrentManagedStackSourcePluginGeneration = {
  pluginId: 'examples.production-hosted-reference',
  desiredGeneration: GENERATION,
  appliedGeneration: GENERATION,
  contributionProjectionGeneration: 'projection-1',
};

function buildQaEnv(pluginRoot: string): NodeJS.ProcessEnv {
  return {
    HAPPIER_TAURI_HOSTED_PLUGIN_ROOT: pluginRoot,
    HAPPIER_TAURI_HOSTED_PLUGIN_ID: 'examples.production-hosted-reference',
    HAPPIER_TAURI_HOSTED_ARTIFACT_ID: HOSTED_ARTIFACT_ID,
    HAPPIER_TAURI_HOSTED_ROUTE: '/settings/plugins',
    HAPPIER_TAURI_HOSTED_SURFACE_ID: 'review-dashboard',
    HAPPIER_TAURI_HOSTED_TITLE: 'Review dashboard',
  };
}

type QaRunnerInput = Readonly<{
  config: Readonly<{ expected: Readonly<Record<string, string>> }>;
}>;
type QaRunnerResult = Readonly<{
  artifactRoot: string;
  capability: unknown;
  identity: unknown;
  proof: Readonly<{
    kind: string;
    hostBoundaryOnly: boolean;
    nativeChildProofComplete: boolean;
  }>;
}>;

function incompleteCapture(artifactRoot: string): QaRunnerResult {
  return Object.freeze({
    artifactRoot,
    capability: { kind: 'available' },
    identity: {},
    proof: Object.freeze({
      kind: 'capture_ready_for_native_child_checks',
      hostBoundaryOnly: true,
      nativeChildProofComplete: false,
    }),
  });
}

function completeCapture(artifactRoot: string): QaRunnerResult {
  return Object.freeze({
    artifactRoot,
    capability: { kind: 'available' },
    identity: {},
    proof: Object.freeze({
      kind: 'native_child_checks_complete',
      hostBoundaryOnly: false,
      nativeChildProofComplete: true,
    }),
  });
}

function buildDeps(runHostedArtifactPluginUiMcpQa: (input: QaRunnerInput) => Promise<QaRunnerResult>) {
  return {
    resolvePluginUiContext: async () => fakeContext,
    attestPluginUi: async () => fakeAttestation,
    attestSourcePluginGeneration: async () => fakeGeneration,
    runHostedArtifactPluginUiMcpQa,
  };
}

function stream(lines: Array<string>): NodeJS.WritableStream {
  return { write: (chunk: unknown) => { lines.push(String(chunk)); } } as NodeJS.WritableStream;
}

describe('desktop hosted-artifact current-source loaded QA', () => {
  it('binds the attested identity, then refuses capture-preparation results that lack native-child proof', async () => {
    const pluginRoot = await writeCurrentSourcePluginRoot();
    const mod = await import('./desktopHostedArtifactCurrentSourceQa');
    const qaCalls: Array<QaRunnerInput> = [];
    const deps = buildDeps(async (input) => {
      qaCalls.push(input);
      return incompleteCapture('/tmp/hosted-artifact-capture');
    });
    await expect(mod.runDesktopHostedArtifactCurrentSourceQa(buildQaEnv(pluginRoot), deps))
      .rejects.toThrow(/desktop_hosted_artifact_native_child_proof_blocked:capture_ready_for_native_child_checks/u);
    // The deciding identity facts must be attested and passed to the capture
    // before the recorded proof state is judged.
    expect(qaCalls[0]?.config.expected).toEqual({
      pluginId: 'examples.production-hosted-reference',
      generation: GENERATION,
      artifactDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      machineId: 'machine-a',
      serverId: 'server-a',
    });
  });

  it('emits the artifactRoot only when the recorded proof state is complete', async () => {
    const pluginRoot = await writeCurrentSourcePluginRoot();
    const mod = await import('./desktopHostedArtifactCurrentSourceQa');
    const deps = buildDeps(async () => completeCapture('/tmp/hosted-artifact-capture-complete'));
    await expect(mod.runDesktopHostedArtifactCurrentSourceQa(buildQaEnv(pluginRoot), deps))
      .resolves.toEqual({ artifactRoot: '/tmp/hosted-artifact-capture-complete' });
  });

  it('exits nonzero without an artifactRoot success line while native-child proof is incomplete', async () => {
    const pluginRoot = await writeCurrentSourcePluginRoot();
    const mod = await import('./desktopHostedArtifactCurrentSourceQa');
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];
    const exitCode = await mod.runDesktopHostedArtifactCurrentSourceCli({
      env: buildQaEnv(pluginRoot),
      deps: buildDeps(async () => incompleteCapture('/tmp/hosted-artifact-capture')),
      stdout: stream(stdout),
      stderr: stream(stderr),
    });
    expect(exitCode).toBe(1);
    expect(stdout.join('')).not.toContain('/tmp/hosted-artifact-capture');
    expect(stderr.join('')).toContain('desktop_hosted_artifact_native_child_proof_blocked');
    expect(stderr.join('')).toContain('/tmp/hosted-artifact-capture');
  });

  it('exits zero and prints the artifactRoot once native-child proof is complete', async () => {
    const pluginRoot = await writeCurrentSourcePluginRoot();
    const mod = await import('./desktopHostedArtifactCurrentSourceQa');
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];
    const exitCode = await mod.runDesktopHostedArtifactCurrentSourceCli({
      env: buildQaEnv(pluginRoot),
      deps: buildDeps(async () => completeCapture('/tmp/hosted-artifact-capture-complete')),
      stdout: stream(stdout),
      stderr: stream(stderr),
    });
    expect(exitCode).toBe(0);
    expect(stdout.join('')).toContain('/tmp/hosted-artifact-capture-complete');
    expect(stderr.join('')).toBe('');
  });
});
