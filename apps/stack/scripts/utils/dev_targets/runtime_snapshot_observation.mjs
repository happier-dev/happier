/** Render the live-observation branch of the canonical runtime identity probe. */
export function buildRuntimeSnapshotObservationExpression({ target, paths, services }) {
  const components = ['server', 'daemon'].filter(component => services[component] === true);
  return [
    '(async () => {',
    `process.env.HAPPIER_STACK_STORAGE_DIR = ${JSON.stringify(paths.stackStorageDir)};`,
    "const { pathToFileURL } = require('node:url');",
    `const { readStackInfoSnapshot } = await import(pathToFileURL(${JSON.stringify(target.repoDir + '/apps/stack/scripts/stack/stack_info_snapshot.mjs')}).href);`,
    `const info = await readStackInfoSnapshot({ rootDir: ${JSON.stringify(target.repoDir)}, stackName: ${JSON.stringify(paths.stackName)}, observeRemoteSourceRuntime: false, synchronizeDaemonState: false });`,
    'const sourceRuntimeIdentities = {}, serviceStatus = {};',
    `for (const component of ${JSON.stringify(components)}) {`,
    '  sourceRuntimeIdentities[component] = info.runtime.sourceRuntimeIdentities?.[component] ?? null;',
    '  const state = info.runtime.components[component];',
    "  serviceStatus[component] = state.running ? 'running' : state.status ?? (state.ownershipStatus === 'unknown' ? 'unknown' : 'not-running');",
    '}',
    `process.stdout.write(JSON.stringify({ sourceRuntimeIdentities, serviceStatus${services.daemon ? ', managedCli: info.runtime.managedCli, daemonEntry: info.runtime.daemonEntry' : ''} }));`,
    "})().catch(() => fail('runtime_observation_failed'));",
  ].join('\n');
}
