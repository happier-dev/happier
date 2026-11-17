// Usage: node retain_dependency_generation.mjs <installDir> <pid>
// Called by the worker custody wrapper before a routed payload starts (see
// retainDependencyGenerationForProcess): the payload keeps its dependency
// generation until it exits.
import { retainDependencyGenerationForProcess } from './dependency_refresh.mjs';

const [installDir, rawPid] = process.argv.slice(2);
const pid = Number(rawPid);
if (!installDir || !Number.isInteger(pid) || pid <= 1) {
  console.error('usage: retain_dependency_generation.mjs <installDir> <pid>');
  process.exit(64);
}
retainDependencyGenerationForProcess({ installDir, pid });
