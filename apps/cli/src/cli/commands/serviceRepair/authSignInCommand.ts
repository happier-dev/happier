/**
 * One owner for the executable sign-in remedy shared by the doctor report's
 * Authentication section and the repair prompt copy.
 *
 * `happier auth` alone only prints help — `auth login` is the parsed form that
 * actually performs a sign-in — so every printed remedy comes from here.
 */
export function authSignInCommand(invoker: string, serverId?: string): string {
  return serverId ? `${invoker} auth login --server ${serverId}` : `${invoker} auth login`;
}
