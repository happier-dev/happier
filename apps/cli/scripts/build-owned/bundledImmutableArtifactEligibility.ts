export type BundledImmutableArtifactEligibility = Readonly<{
  hasDaemonEntrypoint: boolean;
  hasResources: boolean;
  requiresSessionRunnerFactory: boolean;
  hasManagedProviderRuntime: boolean;
  hasConnectedAccountDescriptors: boolean;
}>;

export function requiresBundledImmutableArtifact(
  eligibility: BundledImmutableArtifactEligibility,
): boolean {
  return eligibility.hasDaemonEntrypoint
    || eligibility.hasResources
    || eligibility.requiresSessionRunnerFactory
    || eligibility.hasManagedProviderRuntime
    || eligibility.hasConnectedAccountDescriptors;
}
