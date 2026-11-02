const path = require('node:path');
const { pathToFileURL } = require('node:url');

const owner = () => import(pathToFileURL(path.join(__dirname, '../../stack/scripts/utils/proc/dependency_refresh.mjs')).href);
const consumeDependencies = async (projectRoot, signal, consume, { waitForPublication = false } = {}) => {
  const { resolveDependencyInstallRoot, withDependencyConsumption } = await owner();
  return withDependencyConsumption({ installDir: resolveDependencyInstallRoot(projectRoot), signal, waitForPublication }, consume);
};

exports.processMetroDependencyChanges = (projectRoot, processChanges, signal) =>
  consumeDependencies(projectRoot, signal, processChanges, { waitForPublication: true });

// HTTP builds, dependency queries and HMR all enter the same DeltaBundler.
// Keep the watcher and status endpoint live while package consumers share the
// installer's existing reader/writer boundary.
exports.protectMetroDependencyConsumption = (metroServer, projectRoot) => {
  const controller = new AbortController();
  const deltaBundler = metroServer.getBundler().getDeltaBundler();
  // DeltaCalculator owns the current-build wait. Its callback runs only for
  // the graph read that is executing, so queued HMR requests retain no lock.
  deltaBundler.unstable_setDependencyConsumption(read =>
    consumeDependencies(projectRoot, controller.signal, read));
  const end = metroServer.end.bind(metroServer);
  metroServer.end = async () => {
    controller.abort();
    await end();
  };
};
