import {
  ProviderRuntimeBindingBasisV1Schema,
  ProviderSettingsV1Schema,
  createProviderMachineGrantFingerprintV1,
  type ProviderRuntimeBindingBasisV1,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

export type RetainedManagedProviderAuthorizationCurrentnessCheck = Readonly<{
  isExactRetainedRuntimeCurrent?: () => boolean;
}>;

/**
 * Binds retained authorization to one exact adopted runtime and makes every
 * later negative custody or live-policy observation non-resurrecting.
 *
 * Before adoption there is no exact runtime to authorize. That absence is a
 * temporary false result rather than a revocation, so the first exact custody
 * callback may still bind later.
 */
export function createRetainedManagedProviderAuthorizationCurrentness(input: Readonly<{
  isRetainedPolicyCurrent: () => boolean;
}>): (
  check: RetainedManagedProviderAuthorizationCurrentnessCheck,
) => boolean {
  let exactRuntimeCurrentness: (() => boolean) | null = null;
  let permanentlyCurrent = true;

  return (check) => {
    if (!permanentlyCurrent) return false;

    const candidate = check.isExactRetainedRuntimeCurrent;
    if (!exactRuntimeCurrentness) {
      if (!candidate) return false;
      exactRuntimeCurrentness = candidate;
    } else if (candidate && candidate !== exactRuntimeCurrentness) {
      permanentlyCurrent = false;
      return false;
    }

    try {
      permanentlyCurrent = exactRuntimeCurrentness()
        && input.isRetainedPolicyCurrent();
    } catch {
      permanentlyCurrent = false;
    }
    return permanentlyCurrent;
  };
}

/**
 * Revalidates the mutable Provider settings/grant slice for one already-adopted
 * managed runtime P. The immutable P declaration, executable, HostAccess,
 * Connected Accounts, request-auth broker, and runner bridge remain checked by
 * their existing owners during retained invocation reconstruction.
 *
 * Current Q is deliberately absent: replacing or removing Q cannot redefine an
 * adopted P's immutable declaration. Revoking the connection or its exact
 * machine grant still fences P immediately through this settings owner.
 */
export function isRetainedManagedProviderSettingsGrantCurrent(input: Readonly<{
  machineId: string;
  providerSettings: ProviderSettingsV1;
  runtimeBindingBasis: ProviderRuntimeBindingBasisV1;
}>): boolean {
  const settings = ProviderSettingsV1Schema.safeParse(input.providerSettings);
  const basis = ProviderRuntimeBindingBasisV1Schema.safeParse(
    input.runtimeBindingBasis,
  );
  const machineId = input.machineId.trim();
  if (
    !settings.success
    || !basis.success
    || !machineId
    || basis.data.deployment.kind !== 'managedLocal'
    || basis.data.contributionKey === null
  ) return false;

  const connection = settings.data.connections.find(
    (candidate) => candidate.id === basis.data.connectionId,
  );
  if (
    !connection
    || connection.deployment.kind !== 'managedLocal'
    || connection.source.kind !== 'contribution'
    || connection.source.contributionKey !== basis.data.contributionKey
  ) return false;

  const expected = basis.data.credentialAuthorization;
  const grant = settings.data.machineGrants.find((candidate) => (
    candidate.machineId === machineId
    && candidate.connectionId === basis.data.connectionId
    && candidate.connectionSecurityFingerprint
      === expected.connectionSecurityFingerprint
  ));
  return grant !== undefined
    && createProviderMachineGrantFingerprintV1(grant)
      === expected.grantFingerprint;
}
