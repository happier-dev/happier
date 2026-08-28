import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computePluginUiArtifactFileSetSha256DigestV1,
  PluginUiArtifactsManifestV1Schema,
} from '@happier-dev/protocol/plugins/ui';

import {
  attestCurrentManagedStackPluginUi,
  attestCurrentManagedStackSourcePluginGeneration,
  resolveCurrentManagedStackPluginUiContext,
} from './currentManagedStackPluginUiQa';
import {
  assertHostedArtifactNativeChildProofComplete,
  runHostedArtifactPluginUiMcpQa,
} from '../../../../../apps/ui/scripts/qa/tauriHostedArtifactPluginUiMcpQa.mjs';

type DesktopHostedArtifactCurrentSourceQaDeps = Readonly<{
  resolvePluginUiContext: typeof resolveCurrentManagedStackPluginUiContext;
  attestPluginUi: typeof attestCurrentManagedStackPluginUi;
  attestSourcePluginGeneration: typeof attestCurrentManagedStackSourcePluginGeneration;
  runHostedArtifactPluginUiMcpQa: typeof runHostedArtifactPluginUiMcpQa;
}>;

const defaultDeps: DesktopHostedArtifactCurrentSourceQaDeps = {
  resolvePluginUiContext: resolveCurrentManagedStackPluginUiContext,
  attestPluginUi: attestCurrentManagedStackPluginUi,
  attestSourcePluginGeneration: attestCurrentManagedStackSourcePluginGeneration,
  runHostedArtifactPluginUiMcpQa,
};

function required(value: string | undefined, code: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(code);
  return normalized;
}

export async function runDesktopHostedArtifactCurrentSourceQa(
  env: NodeJS.ProcessEnv = process.env,
  deps: DesktopHostedArtifactCurrentSourceQaDeps = defaultDeps,
): Promise<Readonly<{ artifactRoot: string }>> {
  const pluginRoot = resolve(required(
    env.HAPPIER_TAURI_HOSTED_PLUGIN_ROOT,
    'desktop_hosted_artifact_plugin_root_missing',
  ));
  const pluginId = required(env.HAPPIER_TAURI_HOSTED_PLUGIN_ID, 'desktop_hosted_artifact_plugin_id_missing');
  const hostedArtifactId = required(
    env.HAPPIER_TAURI_HOSTED_ARTIFACT_ID,
    'desktop_hosted_artifact_id_missing',
  );
  const context = await deps.resolvePluginUiContext({ env });
  const runtimeAttestation = await deps.attestPluginUi({ context });
  const generation = await deps.attestSourcePluginGeneration({ context, pluginId });
  const graph = PluginUiArtifactsManifestV1Schema.parse(JSON.parse(await readFile(
    resolve(pluginRoot, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'),
    'utf8',
  )));
  const artifact = graph.entries.find((entry) => (
    entry.contributionId === hostedArtifactId && entry.tier === 'hostedWeb'
  ));
  if (!artifact) throw new Error(`desktop_hosted_artifact_source_graph_entry_missing:${hostedArtifactId}`);
  const emittedFiles = await Promise.all(artifact.files.map(async (file) => Object.freeze({
    relativePath: file.relativePath,
    bytes: await readFile(join(
      pluginRoot,
      'dist',
      'happier-plugin-ui',
      ...file.relativePath.split('/'),
    )),
  })));
  const emittedDigest = computePluginUiArtifactFileSetSha256DigestV1(emittedFiles);
  if (emittedDigest !== artifact.digest) {
    throw new Error(`desktop_hosted_artifact_source_graph_digest_mismatch:${artifact.digest}:${emittedDigest}`);
  }

  const result = await deps.runHostedArtifactPluginUiMcpQa({
    env: {
      ...env,
      HAPPIER_STACK_TAURI_IDENTIFIER: `com.happier.stack.${context.stackName}`,
    },
    config: Object.freeze({
      appIdentifier: `com.happier.stack.${context.stackName}`,
      route: required(env.HAPPIER_TAURI_HOSTED_ROUTE, 'desktop_hosted_artifact_route_missing'),
      surfaceId: required(env.HAPPIER_TAURI_HOSTED_SURFACE_ID, 'desktop_hosted_artifact_surface_id_missing'),
      title: required(env.HAPPIER_TAURI_HOSTED_TITLE, 'desktop_hosted_artifact_title_missing'),
      expected: Object.freeze({
        pluginId,
        generation: generation.appliedGeneration,
        artifactDigest: artifact.digest,
        machineId: context.daemon.machineId,
        serverId: context.account.serverId,
      }),
    }),
    runtimeAttribution: Object.freeze({
      ...runtimeAttestation,
      sourcePluginRoot: pluginRoot,
      sourceHostedArtifactId: hostedArtifactId,
      sourceHostedArtifactDigest: artifact.digest,
      sourceHostedArtifactEntry: artifact.entry,
      sourcePluginGeneration: generation,
    }),
  });
  assertHostedArtifactNativeChildProofComplete({
    artifactRoot: result.artifactRoot,
    proof: result.proof,
  });
  return Object.freeze({ artifactRoot: result.artifactRoot });
}

export async function runDesktopHostedArtifactCurrentSourceCli(input: Readonly<{
  env?: NodeJS.ProcessEnv;
  deps?: DesktopHostedArtifactCurrentSourceQaDeps;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}> = {}): Promise<number> {
  const stdout = input.stdout ?? process.stdout;
  const stderr = input.stderr ?? process.stderr;
  try {
    const { artifactRoot } = await runDesktopHostedArtifactCurrentSourceQa(
      input.env ?? process.env,
      input.deps ?? defaultDeps,
    );
    stdout.write(`${artifactRoot}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDesktopHostedArtifactCurrentSourceCli().then((exitCode) => { process.exitCode = exitCode; });
}
