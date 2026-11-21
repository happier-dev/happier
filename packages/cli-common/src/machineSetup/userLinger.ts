/**
 * systemd-logind linger keeps an account's user manager, and the user services it
 * enabled, running without a login session. This is the one owner of the enable
 * command and its marker check for recipe steps and the SSH enrollment bootstrap.
 */
export const SYSTEMD_LINGER_MARKER_DIR = '/var/lib/systemd/linger';

export function buildUserLingerStep<U, P, F = never>(
  params: Readonly<{
    id: string;
    username: U;
    markerPath: P;
    requiredFacts?: readonly F[];
  }>,
) {
  return {
    id: params.id,
    kind: 'command' as const,
    executable: 'loginctl',
    args: ['enable-linger', params.username],
    ...(params.requiredFacts
      ? { requiredFacts: [...params.requiredFacts] }
      : {}),
    check: {
      executable: 'test',
      args: ['-f', params.markerPath],
      unsatisfiedExitCodes: [1],
    },
  };
}

export type CurrentUserLingerOutcome =
  | 'linger_enabled'
  | 'linger_not_applicable'
  | 'linger_refused';

/**
 * The enrolling account enables its own linger over SSH (logind authorizes
 * self-linger for the session's user). Prints exactly one outcome token.
 * Hosts without a running systemd have no user manager to keep alive.
 */
export function buildEnsureCurrentUserLingerCommand(): string {
  const step = buildUserLingerStep({
    id: 'enrolling-user-linger',
    username: '$user',
    markerPath: `${SYSTEMD_LINGER_MARKER_DIR}/$user`,
  });
  const check = [
    step.check.executable,
    ...step.check.args.map((arg) => `"${arg}"`),
  ].join(' ');
  const enable = [step.executable, ...step.args.map((arg) => `"${arg}"`)].join(
    ' ',
  );
  return [
    'if [ "$(uname -s)" != Linux ] || [ ! -d /run/systemd/system ] || ! command -v loginctl >/dev/null 2>&1; then echo linger_not_applicable; exit 0; fi',
    'user="$(id -un)"',
    `${check} || ${enable} >/dev/null 2>&1`,
    `if ${check}; then echo linger_enabled; else echo linger_refused; exit 1; fi`,
  ].join('; ');
}

export function readCurrentUserLingerOutcome(
  stdout: string,
): CurrentUserLingerOutcome | null {
  const token = stdout.trim().split(/\r?\n/u).pop()?.trim();
  return token === 'linger_enabled' ||
    token === 'linger_not_applicable' ||
    token === 'linger_refused'
    ? token
    : null;
}
