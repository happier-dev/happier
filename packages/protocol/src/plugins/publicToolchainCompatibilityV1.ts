import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

const NonEmptyVersionSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const AuthoringDependencySchema = lazyZodSchema(() => z.strictObject({
  packageName: z.string().check(z.trim(), z.minLength(1)),
  /** The exact package.json spec emitted for an external author project. */
  dependencySpec: NonEmptyVersionSchema,
  /** The exact resolved package version that the source candidate verified. */
  resolvedVersion: NonEmptyVersionSchema,
}));

/**
 * The generated public authoring packet. It intentionally carries exact
 * release/runtime values, not semver ranges copied into templates.
 */
export const PublicToolchainCompatibilityV1Schema = lazyZodSchema(() => z.strictObject({
  schemaVersion: z.literal(1),
  host: z.strictObject({
    /** Exact source/build provenance; it is not a compatibility range. */
    buildIdentity: z.string().check(z.trim(), z.minLength(1)),
    /**
     * An optional release-owned broad compatibility fact. Generated author
     * projects must not synthesize this from `buildIdentity`; an author that
     * owns a compatible range declares it in their manifest instead.
     */
    enginesHappier: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }),
  pluginSdk: z.strictObject({
    version: NonEmptyVersionSchema,
  }),
  pluginUi: z.strictObject({
    version: NonEmptyVersionSchema,
    pluginSdkVersion: NonEmptyVersionSchema,
  }),
  framework: z.strictObject({
    react: NonEmptyVersionSchema,
    reactNative: NonEmptyVersionSchema,
    reactNativeWeb: NonEmptyVersionSchema,
    expo: NonEmptyVersionSchema,
    runtime: NonEmptyVersionSchema,
  }),
  ui: z.strictObject({
    artifactGrammarVersion: z.number().check(z.int(), z.positive()),
    hostApiVersion: NonEmptyVersionSchema,
  }),
  /**
   * Generated project dependencies that are neither the SDK/plugin-ui pair nor
   * one of the framework-version fields above. Keeping their emitted package
   * spec beside the resolved source fact prevents scaffolds from carrying a
   * second hand-maintained dependency table.
   */
  authoringDependencies: z.strictObject({
    nodeTypes: AuthoringDependencySchema,
    reactDom: AuthoringDependencySchema,
    reactTypes: AuthoringDependencySchema,
    /** Project-local TypeScript 5 compiler API used to load TypeScript build configuration. */
    typescript: AuthoringDependencySchema,
    typescriptNative: AuthoringDependencySchema,
  }),
}));
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
  const authoringPackageNames = new Set<string>();
  for (const dependency of Object.values(packet.authoringDependencies)) {
    if (authoringPackageNames.has(dependency.packageName)) {
      throw new Error(`Public toolchain packet contains duplicate authoring dependency ${dependency.packageName}.`);
    }
    authoringPackageNames.add(dependency.packageName);
  }
  return packet;
}
