import { z } from 'zod';

const NonEmptyVersionSchema = z.string().trim().min(1);
const BuildToolSchema = z.object({
  packageName: z.string().trim().min(1),
  packageVersion: NonEmptyVersionSchema,
  executable: z.string().trim().min(1),
  executableVersion: NonEmptyVersionSchema,
}).strict();
const AuthoringDependencySchema = z.object({
  packageName: z.string().trim().min(1),
  /** The exact package.json spec emitted for an external author project. */
  dependencySpec: NonEmptyVersionSchema,
  /** The exact resolved package version that the source candidate verified. */
  resolvedVersion: NonEmptyVersionSchema,
}).strict();

/**
 * The generated public authoring packet. It intentionally carries exact
 * release/runtime values, not semver ranges copied into templates.
 */
export const PublicToolchainCompatibilityV1Schema = z.object({
  schemaVersion: z.literal(1),
  host: z.object({
    /** Exact source/build provenance; it is not a compatibility range. */
    buildIdentity: z.string().trim().min(1),
    /**
     * An optional release-owned broad compatibility fact. Generated author
     * projects must not synthesize this from `buildIdentity`; an author that
     * owns a compatible range declares it in their manifest instead.
     */
    enginesHappier: z.string().trim().min(1).optional(),
  }).strict(),
  pluginSdk: z.object({
    version: NonEmptyVersionSchema,
  }).strict(),
  pluginUi: z.object({
    version: NonEmptyVersionSchema,
    pluginSdkVersion: NonEmptyVersionSchema,
  }).strict(),
  framework: z.object({
    react: NonEmptyVersionSchema,
    reactNative: NonEmptyVersionSchema,
    reactNativeWeb: NonEmptyVersionSchema,
    vite: NonEmptyVersionSchema,
    repack: NonEmptyVersionSchema,
    expo: NonEmptyVersionSchema,
    runtime: NonEmptyVersionSchema,
  }).strict(),
  ui: z.object({
    artifactGrammarVersion: z.number().int().positive(),
    hostApiVersion: NonEmptyVersionSchema,
  }).strict(),
  /**
   * Generated project dependencies that are neither the SDK/plugin-ui pair nor
   * one of the framework-version fields above. Keeping their emitted package
   * spec beside the resolved source fact prevents scaffolds from carrying a
   * second hand-maintained dependency table.
   */
  authoringDependencies: z.object({
    nodeTypes: AuthoringDependencySchema,
    reactDom: AuthoringDependencySchema,
    reactTypes: AuthoringDependencySchema,
    reactNativeCommunityCli: AuthoringDependencySchema,
    rspack: AuthoringDependencySchema,
    swcHelpers: AuthoringDependencySchema,
    /** Project-local TypeScript 5 compiler API used to load TypeScript build configuration. */
    typescript: AuthoringDependencySchema,
    typescriptNative: AuthoringDependencySchema,
    viteReactPlugin: AuthoringDependencySchema,
  }).strict(),
  buildTools: z.array(BuildToolSchema).min(1).max(32),
}).strict();
export type PublicToolchainCompatibilityV1 = z.infer<typeof PublicToolchainCompatibilityV1Schema>;

/**
 * Validates the cross-package relationships that syntax alone cannot express.
 * Callers receive a parsed immutable-shaped packet or a loud incompatibility;
 * they never synthesize a best-effort version table.
 */
export function assertCoherentPublicToolchainCompatibilityV1(
  input: unknown,
): PublicToolchainCompatibilityV1 {
  const packet = PublicToolchainCompatibilityV1Schema.parse(input);
  if (packet.pluginUi.pluginSdkVersion !== packet.pluginSdk.version) {
    throw new Error(
      `Public plugin UI package expects plugin SDK ${packet.pluginUi.pluginSdkVersion}, but the generated packet contains ${packet.pluginSdk.version}.`,
    );
  }
  const buildToolKeys = new Set<string>();
  for (const buildTool of packet.buildTools) {
    const key = `${buildTool.packageName}\u0000${buildTool.executable}`;
    if (buildToolKeys.has(key)) {
      throw new Error(`Public toolchain packet contains a duplicate build tool ${buildTool.packageName}/${buildTool.executable}.`);
    }
    buildToolKeys.add(key);
  }
  const authoringPackageNames = new Set<string>();
  for (const dependency of Object.values(packet.authoringDependencies)) {
    if (authoringPackageNames.has(dependency.packageName)) {
      throw new Error(`Public toolchain packet contains duplicate authoring dependency ${dependency.packageName}.`);
    }
    authoringPackageNames.add(dependency.packageName);
  }
  return packet;
}
