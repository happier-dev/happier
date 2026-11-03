import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from '@happier-dev/protocol/plugins/contributions/catalog';
import { PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2 } from '@happier-dev/protocol/plugins/manifest/v2';

import {
  deriveCapabilityMatrixMetadata,
  projectCapabilityMatrix,
  readDefinePluginCapabilityPolicy,
  readPluginServicesCapabilityCatalog,
  renderCapabilityMatrix,
} from './capabilityMatrix.mjs';
import { CAPABILITY_MATRIX_DECLARATIONS_V1 } from './capabilityMatrixMetadata.mjs';

async function projectCurrentCapabilityMatrix({
  packageRoot,
  apiInventory,
  contributionCatalog = PLUGIN_CONTRIBUTION_CATALOG_V2,
  hostAccessCatalog = PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2,
  declarations = CAPABILITY_MATRIX_DECLARATIONS_V1,
}) {
  const root = resolve(packageRoot);
  const [definePluginSource, servicesSource, accountContextSource] = await Promise.all([
    readFile(resolve(root, 'src/definePlugin.ts'), 'utf8'),
    readFile(resolve(root, 'src/services/index.ts'), 'utf8'),
    readFile(resolve(root, 'src/actions/contracts.ts'), 'utf8'),
  ]);
  const services = readPluginServicesCapabilityCatalog(servicesSource, accountContextSource);
  return projectCapabilityMatrix({
    contributionCatalog,
    hostAccessCatalog,
    definePluginPolicy: readDefinePluginCapabilityPolicy(definePluginSource),
    apiInventory,
    services,
    metadata: deriveCapabilityMatrixMetadata({
      contributionCatalog,
      hostAccessCatalog,
      apiInventory,
      services,
      declarations,
    }),
  });
}

/**
 * Produces bytes only. `apiSurfaceCli` remains the sole atomic output writer
 * for the SDK's generated public-contract artifacts.
 */
export async function createCapabilityMatrixOutput({
  packageRoot,
  apiInventory,
  contributionCatalog = PLUGIN_CONTRIBUTION_CATALOG_V2,
  hostAccessCatalog = PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2,
  declarations = CAPABILITY_MATRIX_DECLARATIONS_V1,
}) {
  const root = resolve(packageRoot);
  const matrix = await projectCurrentCapabilityMatrix({
    packageRoot: root,
    apiInventory,
    contributionCatalog,
    hostAccessCatalog,
    declarations,
  });
  return Object.freeze({
    owner: 'capabilityMatrix',
    relativePath: 'capability-matrix.json',
    contents: renderCapabilityMatrix(matrix),
  });
}
