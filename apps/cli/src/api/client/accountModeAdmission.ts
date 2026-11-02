import { AccountModeDowngradeUnverifiedError, admitMachineRowPlainMode, admitReportedAccountMode } from '@happier-dev/sync-client';

import { readAccountE2eeCustody, readAccountE2eeCustodyForToken, type AccountE2eeCustodyHolder } from '@/persistence';

/** The shared refusal, naming the one command that resolves it on this computer. */
export class CliAccountModeDowngradeUnverifiedError extends AccountModeDowngradeUnverifiedError {
  constructor() {
    super('The Home reports this Account as unencrypted, but this computer still holds its active encryption keys. '
      + 'Run `happier auth keep-encryption-keys` to keep them for older encrypted history and continue.');
  }
}

/**
 * The credential that made the request. An in-hand credential supplies its own
 * custody; a caller holding only a bearer reads the stored credential for it.
 */
export type AccountModeRequestCredential = AccountE2eeCustodyHolder | Readonly<{ token: string }>;

/**
 * Applies the shared Account mode admission decision to a Home-reported mode.
 * Custody is read only for a reported `plain`.
 */
export async function admitCliReportedAccountMode<Mode extends 'plain' | 'e2ee'>(
  reported: Mode,
  credential: AccountModeRequestCredential,
): Promise<Mode> {
  if (reported !== 'plain') return reported;
  const custody = 'encryption' in credential
    ? readAccountE2eeCustody(credential)
    : await readAccountE2eeCustodyForToken(credential.token);
  try {
    return admitReportedAccountMode({ reported, custody });
  } catch {
    throw new CliAccountModeDowngradeUnverifiedError();
  }
}

/** An own-Account Machine row the Home reports plain, admitted with the in-hand credential's custody. */
export function admitCliMachineRowPlainMode(input: Readonly<{
  access: unknown;
  credentials: AccountE2eeCustodyHolder;
  viewerAccountId: string | undefined;
}>): void {
  try {
    admitMachineRowPlainMode({ access: input.access, viewerAccountId: input.viewerAccountId,
      custody: readAccountE2eeCustody(input.credentials) });
  } catch {
    throw new CliAccountModeDowngradeUnverifiedError();
  }
}
