import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  PLUGIN_CONTRIBUTION_CATALOG_V2,
  PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2,
} from '@happier-dev/protocol';

import {
  capabilityMatrixProvingConsumerExerciseFailure,
  deriveCapabilityMatrixMetadata,
  projectCapabilityMatrix,
  readDefinePluginCapabilityPolicy,
  readPluginServicesCapabilityCatalog,
  renderCapabilityMatrix,
} from './capabilityMatrix.mjs';
import { CAPABILITY_MATRIX_DECLARATIONS_V1 } from './capabilityMatrixMetadata.mjs';

function availableRows(matrix) {
  return [
    ...(matrix.manifestFamilies ?? []).map((row) => ({ label: `manifestFamilies.${row.manifestFamily}`, row })),
    ...(matrix.services ?? []).map((row) => ({ label: `services.${row.serviceId}`, row })),
    ...matrix.hostAccess.map((row) => ({ label: `hostAccess.${row.capability}`, row })),
    ...matrix.subpaths.map((row) => ({ label: `subpaths.${row.specifier}`, row })),
  ].filter(({ row }) => row.availabilityDisposition === 'available');
}

/**
 * Selects the repository-relative proof leaves that a package sandbox must
 * retain for every capability advertised as currently available. The matrix is
 * the sole inventory owner; callers never maintain a second path list.
 */
export function selectAvailableCapabilityMatrixProvingConsumerSourcePaths(matrix) {
  return Object.freeze([
    ...new Set(availableRows(matrix).map(({ row }) => row.provingConsumer)),
  ].sort());
}

/**
 * The matrix's textual policy validates the public consumer corridor. This
 * filesystem boundary proves that the named current-tree consumer is still a
 * real source file rather than a stale path or a host-binder placeholder, and
 * that its bytes actually exercise the capability the row advertises. A path
 * check alone cannot fail for a file that merely re-exports something else, so
 * availability is read out of the consumer's source, never out of its
 * existence.
 */
export async function assertCapabilityMatrixProvingConsumerPaths({ packageRoot, matrix }) {
  const repoRoot = resolve(packageRoot, '..', '..');
  for (const { label, row } of availableRows(matrix)) {
    const absolutePath = resolve(repoRoot, row.provingConsumer);
    let stat;
    try {
      stat = await lstat(absolutePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`${label} provingConsumer path does not name a regular file: ${row.provingConsumer}`);
      }
      throw error;
    }
    if (!stat.isFile()) {
      throw new Error(`${label} provingConsumer path does not name a regular file: ${row.provingConsumer}`);
    }
    const exerciseFailure = capabilityMatrixProvingConsumerExerciseFailure(
      row,
      await readFile(absolutePath, 'utf8'),
    );
    if (exerciseFailure) {
      throw new Error(`${label} provingConsumer ${row.provingConsumer} ${exerciseFailure}`);
    }
  }
}

async function projectCurrentCapabilityMatrix({
  packageRoot,
  apiInventory,
  contributionCatalog = PLUGIN_CONTRIBUTION_CATALOG_V2,
  hostAccessCatalog = PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2,
  declarations = CAPABILITY_MATRIX_DECLARATIONS_V1,
}) {
  const root = resolve(packageRoot);
  const [definePluginSource, servicesSource] = await Promise.all([
    readFile(resolve(root, 'src/definePlugin.ts'), 'utf8'),
    readFile(resolve(root, 'src/services/index.ts'), 'utf8'),
  ]);
  const services = readPluginServicesCapabilityCatalog(servicesSource);
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
 * Resolves every available capability proof from the canonical current SDK
 * inputs. Package staging consumes this selector instead of duplicating
 * proving-consumer paths or capability-specific exceptions.
 */
export async function resolveAvailableCapabilityMatrixProvingConsumerSourcePaths({ packageRoot }) {
  const root = resolve(packageRoot);
  // `apiSurfaceCli` composes this output, so source staging asks its canonical
  // source projection here rather than taking authority from a prior generated
  // inventory file.
  const { readCurrentApiSurfaceInventory } = await import('./apiSurfaceCli.mjs');
  const apiInventory = await readCurrentApiSurfaceInventory({ packageRoot: root });
  const matrix = await projectCurrentCapabilityMatrix({ packageRoot: root, apiInventory });
  await assertCapabilityMatrixProvingConsumerPaths({ packageRoot: root, matrix });
  return selectAvailableCapabilityMatrixProvingConsumerSourcePaths(matrix);
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
  await assertCapabilityMatrixProvingConsumerPaths({ packageRoot: root, matrix });
  return Object.freeze({
    owner: 'capabilityMatrix',
    relativePath: 'capability-matrix.json',
    contents: renderCapabilityMatrix(matrix),
  });
}
