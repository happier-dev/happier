import { existsSync } from 'node:fs';
import {
  inspectServiceRegistration,
  resolveServiceBackend,
  resolveServiceDefinitionPath,
} from '@happier-dev/cli-common/service';

function resolveCandidateModes(platform) {
  if (platform === 'darwin') return ['user'];
  if (platform === 'linux' || platform === 'win32') return ['user', 'system'];
  throw new Error(`[stack] archive service cleanup is unsupported on platform: ${platform}`);
}

export async function disableInstalledStackServicesBeforeArchive({
  rootDir,
  stackName,
  platform = process.platform,
  homeDir,
  label = stackName === 'main' ? 'dev.happier.stack' : `dev.happier.stack.${stackName}`,
  modes = resolveCandidateModes(platform),
  resolveDefinitionPath = ({ mode }) => resolveServiceDefinitionPath({ platform, mode, homeDir, label }),
  definitionExists = (path) => existsSync(path),
  inspectRegistration = ({ mode }) => inspectServiceRegistration({
    backend: resolveServiceBackend({ platform, mode }),
    label,
  }),
  uninstallStackService,
} = {}) {
  if (typeof uninstallStackService !== 'function') {
    throw new Error('[stack] archive service cleanup requires the canonical service uninstall owner');
  }

  const removedModes = [];
  for (const mode of modes) {
    const path = resolveDefinitionPath({ mode });
    const hasDefinition = definitionExists(path);
    // Definitions and OS registration can drift independently. Inspection is read-only and is
    // required for every canonical mode before deciding whether the uninstall owner must run.
    // eslint-disable-next-line no-await-in-loop
    const registration = await inspectRegistration({ mode, path });
    if (!hasDefinition && registration !== 'registered') continue;
    // eslint-disable-next-line no-await-in-loop
    await uninstallStackService({ rootDir, stackName, svcCmd: 'uninstall', args: [`--mode=${mode}`] });
    removedModes.push(mode);
  }
  return { removedModes };
}
