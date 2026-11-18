import type { MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

/** A local sandbox kind: its declaration enrolls a sandbox that runs on the managing machine and bills nobody. */
export function isLocalSandboxKind(
  descriptor: Pick<
    MachineProvisionerContributionV1,
    'enrollmentRole' | 'billing'
  >,
): boolean {
  return (
    descriptor.enrollmentRole === 'sandbox' &&
    descriptor.billing?.location === 'local'
  );
}

/**
 * Whether a preset page shows the sections for presets made for others (Create one, Who can use it, Running at
 * once). A personal local sandbox preset is that machine's own, used by its Isolation, so it leaves them out (lab
 * machine-sandboxes-1115 decision 3); a Team preset keeps them, since sharing is its decision. While the kind is
 * still being read the answer is `unknown`, and the page shows nothing for them rather than a guess that would
 * appear and then leave.
 */
export function resolvePresetSharedSections(
  input: Readonly<{
    ownerKind: 'account' | 'team';
    descriptor:
      | Pick<MachineProvisionerContributionV1, 'enrollmentRole' | 'billing'>
      | undefined;
    kindLoading: boolean;
  }>,
): 'show' | 'hide' | 'unknown' {
  if (input.ownerKind === 'team') return 'show';
  if (input.descriptor)
    return isLocalSandboxKind(input.descriptor) ? 'hide' : 'show';
  return input.kindLoading ? 'unknown' : 'show';
}
