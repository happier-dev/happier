import { t } from '@/text';
import {
  isVersionSupported,
  MINIMUM_CLI_VERSION,
} from '@/utils/system/versionUtils';

/** The command a person runs on the Machine to bring its Happier CLI up to date. */
export const SESSION_CLI_UPDATE_COMMAND = 'happier self update';

export type SessionCliVersionNotice = Readonly<{
  title: string;
  reason: string;
  command: string;
}>;

/** Whether a Session's reported CLI version is below the minimum this app supports. */
export function isSessionCliVersionBelowMinimum(
  version: string | null | undefined,
): boolean {
  return (
    typeof version === 'string' &&
    version.length > 0 &&
    !isVersionSupported(version, MINIMUM_CLI_VERSION)
  );
}

/**
 * The one presentation of "this Session's CLI is below the minimum" (owner 11-16 F3): Session Info's card
 * and the composer's notice both say it with these words and offer the same command to copy. A runner that
 * is merely older than the Machine's installed CLI is the stale-runner notice, not this one.
 */
export function resolveSessionCliVersionNotice(
  input: Readonly<{
    version: string | null | undefined;
    machineLabel: string | null | undefined;
  }>,
): SessionCliVersionNotice | null {
  if (!isSessionCliVersionBelowMinimum(input.version)) return null;
  return {
    title: input.machineLabel
      ? t('sessionPages.info.cliNoticeTitle', { machine: input.machineLabel })
      : t('sessionInfo.cliVersionOutdated'),
    reason: t('sessionPages.info.cliNoticeReason', {
      version: MINIMUM_CLI_VERSION,
      command: SESSION_CLI_UPDATE_COMMAND,
    }),
    command: SESSION_CLI_UPDATE_COMMAND,
  };
}
