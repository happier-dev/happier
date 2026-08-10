// @ts-check

/**
 * @typedef {{
 *   id: 'cli' | 'hstack' | 'server';
 *   pipelineLabel: string;
 *   publishSurfaceLabel: string;
 *   minisignRequirementLabel: string;
 *   packageJsonPath: string;
 *   patchPackageVersionOnRolling: boolean;
 *   buildScriptPath: string;
 *   artifactsDir: string;
 *   manifestProduct: 'happier' | 'hstack' | 'happier-server';
 *   manifestOutDir: string;
 *   checksumProductStem: string;
 *   rollingTagPrefix: string;
 *   versionTagPrefix: string;
 *   releaseTitleBase: string;
 *   rollingNotesSubject: string;
 *   versionNotesSubject: string;
 *   notarizationEvidenceSuffix: 'cli' | 'hstack' | 'server';
 *   artifactTargets: ReadonlyArray<Readonly<{ os: string; arch: string }>>;
 * }} BinaryPublishProductSpec
 */

export const BINARY_PUBLISH_TARGETS = Object.freeze([
  Object.freeze({ os: 'linux', arch: 'x64' }),
  Object.freeze({ os: 'linux', arch: 'arm64' }),
  Object.freeze({ os: 'darwin', arch: 'x64' }),
  Object.freeze({ os: 'darwin', arch: 'arm64' }),
  Object.freeze({ os: 'windows', arch: 'x64' }),
]);

/** @type {ReadonlyArray<BinaryPublishProductSpec['id']>} */
export const BINARY_PUBLISH_PRODUCT_IDS = Object.freeze(['cli', 'hstack', 'server']);

/** @type {Readonly<Record<BinaryPublishProductSpec['id'], Readonly<BinaryPublishProductSpec>>>} */
const PRODUCT_SPECS = Object.freeze({
  cli: Object.freeze({
    id: 'cli',
    pipelineLabel: 'cli-binaries',
    publishSurfaceLabel: 'CLI binary publishing',
    minisignRequirementLabel: 'CLI release artifacts',
    packageJsonPath: 'apps/cli/package.json',
    patchPackageVersionOnRolling: true,
    buildScriptPath: 'scripts/pipeline/release/build-cli-binaries.mjs',
    artifactsDir: 'dist/release-assets/cli',
    manifestProduct: 'happier',
    manifestOutDir: 'dist/release-assets/cli/manifests',
    checksumProductStem: 'happier',
    rollingTagPrefix: 'cli',
    versionTagPrefix: 'cli-v',
    releaseTitleBase: 'Happier CLI',
    rollingNotesSubject: 'CLI binaries',
    versionNotesSubject: 'CLI',
    notarizationEvidenceSuffix: 'cli',
    artifactTargets: BINARY_PUBLISH_TARGETS,
  }),
  hstack: Object.freeze({
    id: 'hstack',
    pipelineLabel: 'hstack-binaries',
    publishSurfaceLabel: 'hstack binary publishing',
    minisignRequirementLabel: 'hstack release artifacts',
    packageJsonPath: 'apps/stack/package.json',
    patchPackageVersionOnRolling: true,
    buildScriptPath: 'scripts/pipeline/release/build-hstack-binaries.mjs',
    artifactsDir: 'dist/release-assets/stack',
    manifestProduct: 'hstack',
    manifestOutDir: 'dist/release-assets/stack/manifests',
    checksumProductStem: 'hstack',
    rollingTagPrefix: 'stack',
    versionTagPrefix: 'stack-v',
    releaseTitleBase: 'Happier Stack',
    rollingNotesSubject: 'hstack binaries',
    versionNotesSubject: 'hstack',
    notarizationEvidenceSuffix: 'hstack',
    artifactTargets: BINARY_PUBLISH_TARGETS,
  }),
  server: Object.freeze({
    id: 'server',
    pipelineLabel: 'server-runtime',
    publishSurfaceLabel: 'server runtime publishing',
    minisignRequirementLabel: 'server runtime release artifacts',
    packageJsonPath: 'apps/server/package.json',
    patchPackageVersionOnRolling: false,
    buildScriptPath: 'scripts/pipeline/release/build-server-binaries.mjs',
    artifactsDir: 'dist/release-assets/server',
    manifestProduct: 'happier-server',
    manifestOutDir: 'dist/release-assets/server/manifests',
    checksumProductStem: 'happier-server',
    rollingTagPrefix: 'server',
    versionTagPrefix: 'server-v',
    releaseTitleBase: 'Happier Server',
    rollingNotesSubject: 'server runtime release',
    versionNotesSubject: 'Server runtime',
    notarizationEvidenceSuffix: 'server',
    artifactTargets: BINARY_PUBLISH_TARGETS,
  }),
});

/**
 * @param {string} productId
 * @returns {Readonly<BinaryPublishProductSpec>}
 */
export function getBinaryPublishProductSpec(productId) {
  const spec = PRODUCT_SPECS[/** @type {BinaryPublishProductSpec['id']} */ (productId)];
  if (!spec) {
    throw new Error(`Unknown binary publish product: ${productId}`);
  }
  return spec;
}
