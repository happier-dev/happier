import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveDependencyInstallRoot, waitForDependencyRefresh } from '../../utils/proc/dependency_refresh.mjs';
import { getStacksStorageRoot } from '../../utils/paths/paths.mjs';
import { projectRemoteGuestCliPayloadEnvironment, readPublishedSourceRuntimeRecord, sourceRuntimeCandidateKey } from '../shared/source_bundle_record.mjs';
import { readCliDistIntegrity, resolveCliDistEntrypointFromBin } from '../../utils/cli/cliDistIntegrity.mjs';

function resolveTsxCliEntrypoint(cliDir) {
  const srcEntrypoint = join(cliDir, 'src', 'index.ts');
  // The source CLI shares the checkout's source-tool workspace resolver, so
  // workspace packages load their authored exports instead of compiled dist.
  const sourceRuntimePath = join(cliDir, '..', '..', 'packages', 'cli-common', 'registerSourceRuntime.mjs');
  if (!existsSync(srcEntrypoint) || !existsSync(sourceRuntimePath)) {
    return null;
  }

  return {
    kind: 'tsx',
    nodeArgs: ['--conditions=happier-source', '--import', pathToFileURL(sourceRuntimePath).href, srcEntrypoint],
    distEntrypoint: resolveCliDistEntrypointFromBin(join(cliDir, 'bin', 'happier.mjs')),
    tsconfigPath: join(cliDir, 'tsconfig.json'),
  };
}

function resolveDistCliEntrypoint(cliDir) {
  const packagedEntrypoint = resolveCliDistEntrypointFromBin(join(cliDir, 'bin', 'happier.mjs'));
  const packagedIntegrity = readCliDistIntegrity(packagedEntrypoint);
  if (!packagedIntegrity.ok) {
    return null;
  }
  return { kind: 'dist', nodeArgs: [packagedEntrypoint], distEntrypoint: packagedEntrypoint };
}

export async function resolveCliEntrypoint({ cliDir, preferSource = false, env = process.env, signal } = {}) {
  const root = String(cliDir ?? '').trim();
  if (!root) return null;

  const entrypoint = preferSource
    ? resolveTsxCliEntrypoint(root) ?? resolveDistCliEntrypoint(root)
    : resolveDistCliEntrypoint(root) ?? resolveTsxCliEntrypoint(root);
  // A source launch reads the host's live installation. Observe its existing
  // writer before admitting the preload, without leasing a long-lived CLI.
  if (entrypoint?.kind === 'tsx') {
    await waitForDependencyRefresh({ installDir: resolveDependencyInstallRoot(root), env, signal });
    let payloadEnv = projectRemoteGuestCliPayloadEnvironment(env);
    if (!String(env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT ?? '').trim()) {
      const repoDir = resolve(root, '../..');
      const record = await readPublishedSourceRuntimeRecord({
        bundleRoot: join(getStacksStorageRoot(env), 'source-bundles'),
        candidateKey: sourceRuntimeCandidateKey({ repoDir, component: 'daemon', serverComponent: 'happier-server-light' }),
      });
      payloadEnv = projectRemoteGuestCliPayloadEnvironment(record?.env ?? {});
    }
    return { ...entrypoint, env: payloadEnv };
  }
  return entrypoint;
}
