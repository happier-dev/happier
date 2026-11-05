import chalk from 'chalk';
import { cmd, warn } from '@happier-dev/cli-common/output';
import { USAGE as API_TOKEN_USAGE } from './apiTokensHelp';
import { ACCOUNT_SECURITY_USAGE, CLI_APPROVALS_USAGE } from './accountSecurityHelp';
import { NATIVE_EMAIL_USAGE } from './nativeEmailHelp';
import { USAGE as AUTH_SERVICE_USAGE } from './serviceHelp';

export function printAuthFamilyHelp(args: readonly string[]): void {
  switch (args[1]) {
    case 'api-tokens': console.log(API_TOKEN_USAGE); return;
    case 'security': console.log('Usage: happier auth security get [--json]'); return;
    case 'cli-approvals': console.log(CLI_APPROVALS_USAGE); return;
    case 'password': console.log(ACCOUNT_SECURITY_USAGE); return;
    case 'email':
    case 'recovery-key': console.log(NATIVE_EMAIL_USAGE); return;
    case 'service': console.log(AUTH_SERVICE_USAGE); return;
    case 'login':
      if (args.includes('--email')) { console.log(NATIVE_EMAIL_USAGE); return; }
  }
  showAuthHelp();
}

export function showLogoutDeprecation(): void {
  console.log(`${warn(`${cmd('happier logout')} is deprecated. Use ${cmd('happier auth logout')} instead.`)}\n`);
}

export function showLogoutHelp(): void {
  showLogoutDeprecation();
  showAuthHelp();
}

export function showAuthHelp(): void {
  console.log(`
${chalk.bold('happier auth')} - Authentication management

${chalk.bold('Usage:')}
  happier auth login [--no-open] [--force] [--method web|mobile] [--server <name-or-id> | --server-url <url> [--webapp-url <url>] [--persist|--no-persist]]    Authenticate with Happier
  happier auth login --email <email> --password <password> [--invitation-token <token>] [--json]   Use native email/password on the selected Home
  happier auth login --key <recovery-key> [--json]   Sign in with a recovery key on the selected Home
  happier auth request --json [--server <name-or-id> | --server-url <url> [--webapp-url <url>] [--persist|--no-persist]]                                    Create a claim-gated auth request (headless-friendly)
  happier auth approve --public-key <base64> --json [--request-json-file <path>] [--authorize-unattended-team-access] [--server <name-or-id> | --server-url <url> [--webapp-url <url>] [--persist|--no-persist]]              Approve an auth request using your local credentials
  happier auth wait --public-key <base64> --json [--server <name-or-id> | --server-url <url> [--webapp-url <url>] [--persist|--no-persist]]                Wait for approval and write credentials for this machine
  happier auth pair-remote --ssh <user@host> [--home <saved>|--home-url <url>|--home-descriptor-file <path|->] [--authorize-unattended-team-access] [--json]       Pair a remote machine to a Home over SSH
  happier auth logout [--all]     Log out (selected Home by default)
  happier auth api-tokens create --label <label> [--expires-at <ISO date>] [--encryption] [--authorize-unattended-team-access] [--yes] [--json]
  happier auth api-tokens list [--json]
  happier auth api-tokens revoke <tokenId> [--yes] [--json]
  happier auth api-tokens revoke-all [--yes] [--json]
  happier auth security get [--json]   View Account security (sign-in email, password state)
  happier auth cli-approvals get [--json]   View the Account's CLI/daemon approval policy
  happier auth cli-approvals set allowed|disallowed [--yes] [--json]
  happier auth password change [--current-password <password>] --new-password <password> [--revision <n>] [--recover] [--yes] [--json]
  happier auth password remove [--current-password <password>] [--revision <n>] [--yes] [--json]
  happier auth password enroll-email-request --email <email> [--json]
  happier auth password enroll --email <email> --password <password> [--verification-token <token>] [--yes] [--json]
  happier auth email login --email <email> --password <password> [--invitation-token <token>] [--json]
  happier auth email provision --email <email> [--mode plain|e2ee --password <password> --verification-token <token>] [--json]
  happier auth email connect --email <email> --password <password> [--verification-token <token>] [--yes] [--json]   (routes to Account Security enrollment)
  happier auth email verify-request --email <email> [--json]
  happier auth email reset-request --email <email> [--json]
  happier auth email reset-submit --token <bearer> --new-password <password> [--json]
  happier auth email change-request --email <new-email> [--yes] [--json]
  happier auth email change-complete --verification-token <token> [--json]
  happier auth recovery-key validate --key <recovery-key> [--json]
  happier auth recovery-key login --key <recovery-key> [--json]
  happier auth service status     Show the selected sign-in service, verified against its current identity and role
  happier auth service use <endpoint>   Select a sign-in service and sign in through it
  happier auth service logout     Sign out of the selected service (Homes already entered keep their access)
  happier auth status             Show authentication status
  happier auth keep-encryption-keys
                                  After another device switched this Account to unencrypted, keep this computer's keys for older encrypted history and continue
  happier auth help               Show this help message

${chalk.bold('Options:')}
  --no-open  Do not attempt to open a browser (prints URL instead)
  --force    Clear credentials, machine ID, and stop daemon before re-auth
  --method   Force authentication method (web|mobile). Useful for headless/non-TTY.
  --recover-account-material  Recheck the selected Home mode and recover missing E2EE material (normally used by setup)
  --print-configure-links  Print advanced URL compatibility links for tooling (rare)
  --all      When used with logout, remove local data for all Homes
  --yes      Confirm a dangerous Account security or API-token change without an interactive prompt
  --revision  Expected password credential revision for change/remove (defaults to 1; use "security get" to read the current revision)
  --recover   Replace an E2EE password using the recovery secret from this CLI's current recovery-key/password login
  --invitation-token  Preserve a bounded Team invitation reference through native login/provision; membership stays with the invitation owner
  --verification-token  Mailbox-proof bearer from the verification email for provision or password enrollment
  --secrets-json-stdin  Read one strict {"v":1,"secrets":{...}} document from stdin for noninteractive secret input
  --encryption  With api-tokens create, grant Account-wide encryption access; show the credential once
  --authorize-unattended-team-access  With API-token creation or terminal approval, explicitly copy this signed-in credential's currently verified authentication methods for restricted Team work; ordinary pairing does not copy them
  --json       Print machine-readable JSON (recommended for containers)
  --public-key Used with approve/wait; the terminal public key from "auth request --json"
  --request-json-file  Used with approve; path to the saved "auth request --json" output carrying the request's pairing context
  --ssh        Used with pair-remote; ssh target (e.g. user@host)
  --remote-command       Happier command to run on the remote host (default: happier)
  --server-url-for-remote  Advanced HTTPS compatibility address for the remote host
  --remote-server-url    Legacy alias for --server-url-for-remote
  --remote-local-server-url  Remote-local API URL paired with --remote-server-url
  --remote-webapp-url    Web app URL to persist on the remote host
  --home        Use an existing saved Home profile
  --home-url    Advanced compatibility URL for the target Home
  --home-descriptor-file  Strict Home descriptor JSON file, or - for stdin
  --server      Use an existing saved Home profile
  --server-url  Advanced compatibility URL (does not persist unless --persist)
  --webapp-url  Override the web app URL for this compatibility profile
  --persist     Persist --server-url as the selected profile
  --no-persist  Use --server-url for this invocation only (default)

${chalk.gray('Account security changes require the selected Home\u2019s stored interactive login (present_user); API tokens cannot change passwords or email.')}
${chalk.gray('Password and recovery-key operations never leave this host: they are unavailable to agents, MCP, generic API, and the public plugin SDK.')}
${chalk.gray('E2EE password and recovery-key login derive and open Account material locally; passwords, wrapping keys, and recovery keys never reach the Home.')}
${chalk.gray('E2EE Account Security changes reuse the current recovery secret and never rotate Account signing or content keys.')}
${chalk.gray('API-token revocation stops future API authorization; keys or data already obtained cannot be recalled.')}
${chalk.gray('CLI/daemon approvals are allowed by default. HAPPIER_CLI_PRESENT_USER=disallowed narrows this machine; Account allowed cannot override it.')}
${chalk.gray('Keep Account recovery keys private: anyone with one may be able to recover the Account.')}
${chalk.gray('The CLI stores credentials only for the selected Home and uses Account material only')}
${chalk.gray('when that Account is E2EE; plaintext Accounts do not require fabricated key material.')}
`);
}
