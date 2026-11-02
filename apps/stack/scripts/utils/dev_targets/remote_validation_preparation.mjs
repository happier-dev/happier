import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withDependencyConsumption } from '../proc/dependency_refresh.mjs';

// Protect only module evaluation. The implementation's repair and capacity
// owners run after this scope; they must not inherit a reader that blocks them.
const implementation = await withDependencyConsumption({
  installDir: fileURLToPath(new URL('../../../../../', import.meta.url)),
}, () => import('./remote_validation_workspace.mjs'));

export const { prepareRemoteValidationWorkspace, resolveRemoteValidationPreparationEnv } = implementation;

const entryPath = String(process.argv[1] ?? '').trim();
if (entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  await implementation.runRemoteValidationPreparationCli();
}
