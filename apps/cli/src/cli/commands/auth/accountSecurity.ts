import axios from 'axios';

import { ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1, ACCOUNT_PASSWORD_ENROLL_EMAIL_REQUEST_PATH_V1, AccountEmailChangeRequestV1Schema, AccountPasswordEnrollRequestV1Schema, AccountPasswordEnrollEmailRequestV1Schema, AccountEmailChangeRequestResponseV1Schema, AccountPasswordChangeRequestV1Schema, AccountPasswordRemoveRequestV1Schema, AccountSecurityGetResponseV1Schema, AccountTerminalPresentUserPolicySetRequestV1Schema, AccountTerminalPresentUserPolicySetResponseV1Schema, AccountSecurityRouteErrorV1Schema, PasswordMutationPreparationRequestV1Schema, PasswordMutationPreparationResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { AccountProfileResponseSchema } from '@happier-dev/protocol/account/profile';
import { AccountExternalAuthProofV1Schema } from '@happier-dev/protocol/auth/accountExternalAuthProof';
import { AuthEntryProjectionV1Schema, AuthEntryRequestV1Schema } from '@happier-dev/protocol/auth/entry';
import { ExternalOAuthParamsResponseSchema } from '@happier-dev/protocol/auth/externalOAuth';
import { buildE2eeAccountPasswordChangeRequestV1, buildE2eeAccountPasswordEnrollRequestV1, buildE2eeAccountPasswordRemoveRequestV1 } from '@happier-dev/protocol/auth/accountSecurityCrypto';
import { canonicalizeKeyChallengeV2AudienceOrigin } from '@happier-dev/protocol/auth/keyChallenge';
import { createPasswordCredentialMutationDigestV1, createPasswordCredentialTargetDigestV1 } from '@happier-dev/protocol/auth/passwordMutationChallenge';
import { normalizeVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';
import type { ActionExecuteResult, ActionId, AccountSecurityGetResponseV1, AccountTerminalPresentUserPolicySetResponseV1 } from '@happier-dev/protocol';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { hasStoredSessionCredentialProvenance, readStoredCredentials, type StoredCredentials } from '@/persistence';
import { assertCommandArguments, readCommandPositionals, readFlagValue, readRawFlagValue } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope, wantsJson, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { createExternalAuthProof } from '@/auth/externalAuthProof';

export const ACCOUNT_SECURITY_USAGE =
  'Usage: happier auth security get [--json] | happier auth password change [--current-password <password>] --new-password <password> [--recover] [--json] | happier auth password remove [--current-password <password>] [--json] | happier auth password enroll-email-request --email <email> [--json] | happier auth password enroll --email <email> --password <password> [--verification-token <token>] [--json] | happier auth email change-request --email <email> [--json]';

const CLI_APPROVALS_USAGE = 'Usage: happier auth cli-approvals get [--json] | set allowed|disallowed [--yes] [--json]';

class AccountSecurityCommandError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    const messages: Readonly<Record<string, string>> = {
      unsupported: 'This Home does not support this operation. Update it and try again.',
      not_authenticated: 'Run happier auth login for the selected Home first.',
      present_user_required:
        'Use the selected Home’s stored interactive login to manage Account security. API tokens cannot change passwords or email.',
      cancelled: 'The Account security operation was cancelled before any change began.',
      confirmation_declined: 'Confirmation declined. No change was made.',
      invalid_arguments: ACCOUNT_SECURITY_USAGE,
      recovery_secret_required:
        'This E2EE operation requires the Account recovery secret. Sign in with the password or recovery key on this CLI first.',
      home_identity_unavailable: 'The selected Home identity could not be verified. No password change was made.',
      reauthentication_required:
        'A linked OAuth or mTLS sign-in could not authorize this exact password enrollment. No change was made.',
    };
    super(message ?? messages[code] ?? code);
  }
}

async function createAccountSecurityActionRuntime(
  credentials: StoredCredentials,
  signal?: AbortSignal,
  confirmedActionId?: ActionId,
) {
  const { createCliActionExecutorFromCredentials } = await import(
    '@/session/actions/createCliActionExecutorFromCredentials'
  );
  const serverId = configuration.activeServerId;
  const serverUrl = configuration.serverUrl;
  const serverApiUrl = configuration.apiServerUrl;
  const context = {
    surface: 'cli' as const,
    actionCaller: { kind: 'host' as const },
    serverId,
    ...(signal ? { signal } : {}),
  };
  return {
    serverId,
    serverUrl,
    serverApiUrl,
    executor: createCliActionExecutorFromCredentials({ credentials, serverId, serverApiUrl }),
    context,
    mutationContext: confirmedActionId
      ? { ...context, presentUserConfirmation: { actionId: confirmedActionId } }
      : context,
  };
}

async function readAccountSecurityRoute(
  serverApiUrl: string,
  credentials: StoredCredentials,
  signal?: AbortSignal,
): Promise<AccountSecurityGetResponseV1> {
  signal?.throwIfAborted();
  const response = await axios.get<unknown>(`${serverApiUrl}/v1/account/security`, {
    headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
    timeout: 30_000,
    ...(signal ? { signal } : {}),
    validateStatus: () => true,
  });
  signal?.throwIfAborted();
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      throw new AccountSecurityCommandError('unsupported');
    }
    const parsed = AccountSecurityRouteErrorV1Schema.safeParse(response.data);
    throw new AccountSecurityCommandError(
      parsed.success ? parsed.data.error : 'account_security_operation_failed',
    );
  }
  return AccountSecurityGetResponseV1Schema.parse(response.data);
}

async function readAccountSecurityProjection(
  runtime: Awaited<ReturnType<typeof createAccountSecurityActionRuntime>>,
) {
  return AccountSecurityGetResponseV1Schema.parse(
    unwrap(await runtime.executor.execute('account.security.get', {}, runtime.context)),
  );
}

async function readSelectedAccountSecurity(credentials: StoredCredentials, signal?: AbortSignal) {
  if (hasStoredSessionCredentialProvenance(credentials)) {
    return await readAccountSecurityProjection(await createAccountSecurityActionRuntime(credentials, signal));
  }
  return await readAccountSecurityRoute(configuration.apiServerUrl, credentials, signal);
}

function requireRecoverySecret(credentials: StoredCredentials): Uint8Array {
  if (credentials.encryption?.type !== 'legacy') {
    throw new AccountSecurityCommandError('recovery_secret_required');
  }
  return credentials.encryption.secret;
}

function normalizeSecurityEmail(email: string | null): string | null {
  if (email === null) return null;
  const normalized = normalizeVerifiedEmail(email);
  if (!normalized) throw new AccountSecurityCommandError('account_security_operation_failed');
  return normalized.normalizedEmail;
}

async function resolveMutationAudience(
  runtime: Awaited<ReturnType<typeof createAccountSecurityActionRuntime>>,
  credentials: StoredCredentials,
  signal?: AbortSignal,
) {
  const origin = canonicalizeKeyChallengeV2AudienceOrigin(runtime.serverUrl);
  const snapshot = await fetchServerFeaturesSnapshot({
    serverUrl: runtime.serverApiUrl,
    token: credentials.token,
    ...(signal ? { signal } : {}),
  });
  const serverIdentityId = snapshot.status === 'ready'
    ? snapshot.features.capabilities.serverIdentity.serverIdentityId?.trim() ?? ''
    : '';
  if (!origin || !serverIdentityId) throw new AccountSecurityCommandError('home_identity_unavailable');
  return { origin, serverIdentityId };
}

async function resolveAccountProfile(
  runtime: Awaited<ReturnType<typeof createAccountSecurityActionRuntime>>,
  credentials: StoredCredentials,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const response = await axios.get<unknown>(`${runtime.serverApiUrl}/v1/account/profile`, {
    headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
    timeout: 30_000,
    ...(signal ? { signal } : {}),
    validateStatus: () => true,
  });
  signal?.throwIfAborted();
  if (response.status < 200 || response.status >= 300) {
    throw new AccountSecurityCommandError('account_security_operation_failed');
  }
  const profile = AccountProfileResponseSchema.safeParse(response.data);
  if (!profile.success || profile.data.id.trim().length === 0) {
    throw new AccountSecurityCommandError('account_security_operation_failed');
  }
  return profile.data;
}

async function resolveAccountId(
  runtime: Awaited<ReturnType<typeof createAccountSecurityActionRuntime>>,
  credentials: StoredCredentials,
  signal?: AbortSignal,
): Promise<string> {
  return (await resolveAccountProfile(runtime, credentials, signal)).id;
}

async function acquirePlainEnrollmentExternalAuthProof(input: Readonly<{
  runtime: Awaited<ReturnType<typeof createAccountSecurityActionRuntime>>;
  credentials: StoredCredentials;
  linkedProviderIds: readonly string[];
  requestDigest: string;
  signal?: AbortSignal;
}>) {
  const entryResponse = await axios.post<unknown>(
    `${input.runtime.serverApiUrl}/v1/auth/entry`,
    AuthEntryRequestV1Schema.parse({ v: 1, scope: { kind: 'home' } }),
    {
      headers: { Authorization: `Bearer ${input.credentials.token}`, 'Content-Type': 'application/json' },
      timeout: 30_000,
      ...(input.signal ? { signal: input.signal } : {}),
      validateStatus: () => true,
    },
  );
  input.signal?.throwIfAborted();
  const entry = entryResponse.status >= 200 && entryResponse.status < 300
    ? AuthEntryProjectionV1Schema.safeParse(entryResponse.data)
    : null;
  if (!entry?.success || entry.data.scope.kind !== 'home' || entry.data.state !== 'ready') {
    throw new AccountSecurityCommandError('reauthentication_required');
  }
  const available = new Set(entry.data.actions.flatMap((action) => {
    if (action.action !== 'login' || action.origin !== 'home') return [];
    if (action.methodId === 'mtls') return ['mtls'];
    return action.mode === 'keyless' || action.mode === 'either'
      ? [action.methodId.trim().toLowerCase()]
      : [];
  }));
  const provider = input.linkedProviderIds
    .map((id) => id.trim().toLowerCase())
    .find((id) => id.length > 0 && available.has(id));
  if (!provider) throw new AccountSecurityCommandError('reauthentication_required');

  const { proof, proofHash } = createExternalAuthProof();
  if (provider === 'mtls') {
    const response = await axios.post<unknown>(
      `${input.runtime.serverApiUrl}/v1/auth/mtls`,
      {
        purpose: 'account_password_enrollment',
        proofHash,
        requestDigest: input.requestDigest,
      },
      {
        headers: { Authorization: `Bearer ${input.credentials.token}`, 'Content-Type': 'application/json' },
        timeout: 30_000,
        ...(input.signal ? { signal: input.signal } : {}),
        validateStatus: () => true,
      },
    );
    input.signal?.throwIfAborted();
    const payload = response.data;
    if (
      response.status < 200
      || response.status >= 300
      || !payload
      || typeof payload !== 'object'
      || !('success' in payload)
      || payload.success !== true
      || !('pending' in payload)
      || typeof payload.pending !== 'string'
    ) {
      throw new AccountSecurityCommandError('reauthentication_required');
    }
    return AccountExternalAuthProofV1Schema.parse({ provider, pending: payload.pending, proof });
  }

  const { captureLoopbackOauthRedirect } = await import('@/cloud/loopbackOauthPkce');
  const { openBrowser } = await import('@/ui/openBrowser');
  const callback = await captureLoopbackOauthRedirect({
    callbackPath: `/oauth/${provider}`,
    ...(input.signal ? { signal: input.signal } : {}),
    resolveAuthorizationUrl: async (callbackOrigin) => {
      const query = new URLSearchParams({
        mode: 'keyless',
        purpose: 'account_password_enrollment',
        proofHash,
        requestDigest: input.requestDigest,
      });
      const response = await axios.get<unknown>(
        `${input.runtime.serverApiUrl}/v1/auth/external/${encodeURIComponent(provider)}/params?${query}`,
        {
          headers: { Authorization: `Bearer ${input.credentials.token}`, Origin: callbackOrigin },
          timeout: 30_000,
          ...(input.signal ? { signal: input.signal } : {}),
          validateStatus: () => true,
        },
      );
      const parsed = response.status >= 200 && response.status < 300
        ? ExternalOAuthParamsResponseSchema.safeParse(response.data)
        : null;
      if (!parsed?.success) throw new AccountSecurityCommandError('reauthentication_required');
      return parsed.data.url;
    },
    openAuthorizationUrl: async (url) => {
      if (!await openBrowser(url)) throw new AccountSecurityCommandError('reauthentication_required');
    },
  });
  if (
    callback.error
    || callback.flow !== 'auth'
    || callback.mode !== 'keyless'
    || callback.purpose !== 'account_password_enrollment'
    || typeof callback.pending !== 'string'
    || callback.pending.length === 0
  ) {
    throw new AccountSecurityCommandError('reauthentication_required');
  }
  return AccountExternalAuthProofV1Schema.parse({ provider, pending: callback.pending, proof });
}

async function preparePasswordMutation(
  runtime: Awaited<ReturnType<typeof createAccountSecurityActionRuntime>>,
  credentials: StoredCredentials,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const response = await axios.post<unknown>(
    `${runtime.serverApiUrl}${ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1}`,
    PasswordMutationPreparationRequestV1Schema.parse(body),
    {
      headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
      timeout: 30_000,
      ...(signal ? { signal } : {}),
      validateStatus: () => true,
    },
  );
  signal?.throwIfAborted();
  if (response.status < 200 || response.status >= 300) {
    const parsed = AccountSecurityRouteErrorV1Schema.safeParse(response.data);
    throw new AccountSecurityCommandError(
      parsed.success ? parsed.data.error : 'account_security_operation_failed',
    );
  }
  return response.data;
}

function projectAccountSecurityFailure(error: unknown): { code: string; message: string } {
  if (error instanceof AccountSecurityCommandError) return { code: error.code, message: error.message };
  if (
    axios.isCancel(error)
    || (error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError'))
  ) {
    const cancelled = new AccountSecurityCommandError('cancelled');
    return { code: cancelled.code, message: cancelled.message };
  }
  if (isAuthenticationError(error)) {
    const unauthenticated = new AccountSecurityCommandError('not_authenticated');
    return { code: unauthenticated.code, message: unauthenticated.message };
  }
  return { code: 'account_security_operation_failed', message: 'The Account security operation failed.' };
}

function unwrap(result: ActionExecuteResult): unknown {
  if (!result.ok) {
    throw new AccountSecurityCommandError(result.errorCode ?? 'account_security_operation_failed');
  }
  return result.result;
}

function readSecretFlag(args: readonly string[], flag: string): string | null {
  // Password bytes are caller-owned authentication material. The generic
  // flag reader trims identifier-shaped values, while password inputs must
  // preserve their exact Unicode/UTF-8 sequence across every client.
  const value = readRawFlagValue(args, flag);
  return value && value.length > 0 ? value : null;
}

async function readSecretFlagOrPrompt(args: readonly string[], flag: string, prompt: string): Promise<string> {
  const fromFlag = readSecretFlag(args, flag);
  if (fromFlag) return fromFlag;
  if (args.includes('--json')) {
    throw new AccountSecurityCommandError(
      'invalid_arguments',
      `Option ${flag} requires a value in --json mode. Pass ${flag} <value>.`,
    );
  }
  const { promptSecretInput } = await import('@/terminal/prompts/promptInput');
  const entered = await promptSecretInput(prompt);
  if (!entered) throw new AccountSecurityCommandError('invalid_arguments', `Option ${flag} requires a value.`);
  return entered;
}

async function confirmDangerousAction(message: string, args: readonly string[]): Promise<void> {
  if (args.includes('--yes')) return;
  if (args.includes('--json')) {
    throw new AccountSecurityCommandError(
      'confirmation_declined',
      'Refusing a dangerous Account security change without confirmation. Re-run with --yes after reviewing the consequences.',
    );
  }
  const { promptConfirmYesNo } = await import('@/terminal/prompts/promptConfirmYesNo');
  const confirmed = await promptConfirmYesNo(message, { default: 'no' });
  if (!confirmed) throw new AccountSecurityCommandError('confirmation_declined');
}

export async function handleAuthCliApprovals(args: string[], signal?: AbortSignal): Promise<void> {
  const kind = `auth_cli_approvals_${args[0] ?? 'help'}`;
  try {
    args = await applyServerSelectionFromArgs(args);
    signal?.throwIfAborted();
    const command = args[0];
    if (!command || command === 'help' || args.includes('--help') || args.includes('-h')) {
      console.log(CLI_APPROVALS_USAGE);
      return;
    }
    if (command !== 'get' && command !== 'set') throw new AccountSecurityCommandError('invalid_arguments', CLI_APPROVALS_USAGE);
    try {
      assertCommandArguments(args, { usage: CLI_APPROVALS_USAGE, startIndex: 1,
        booleanFlags: command === 'get' ? ['--json'] : ['--json', '--yes'], valueFlags: [],
        maxPositionals: command === 'get' ? 0 : 1 });
    } catch { throw new AccountSecurityCommandError('invalid_arguments', CLI_APPROVALS_USAGE); }
    const input = command === 'set'
      ? AccountTerminalPresentUserPolicySetRequestV1Schema.safeParse({ policy: readCommandPositionals(args, { startIndex: 1 })[0] })
      : null;
    if (input && !input.success) throw new AccountSecurityCommandError('invalid_arguments', CLI_APPROVALS_USAGE);
    const credentials = await readStoredCredentials();
    if (!credentials) throw new AccountSecurityCommandError('not_authenticated');
    let data: AccountTerminalPresentUserPolicySetResponseV1;
    if (command === 'get') {
      const security = await readSelectedAccountSecurity(credentials, signal);
      data = { policy: security.terminalPresentUserPolicy };
    } else {
      if (!hasStoredSessionCredentialProvenance(credentials)) throw new AccountSecurityCommandError('present_user_required');
      if (!input?.success) throw new AccountSecurityCommandError('invalid_arguments', CLI_APPROVALS_USAGE);
      await confirmDangerousAction(`Set CLI and daemon approval authority to ${input.data.policy}?`, args);
      signal?.throwIfAborted();
      const runtime = await createAccountSecurityActionRuntime(credentials, signal, 'account.security.terminalPresentUser.set');
      data = AccountTerminalPresentUserPolicySetResponseV1Schema.parse(unwrap(await runtime.executor.execute(
        'account.security.terminalPresentUser.set', input.data, runtime.mutationContext,
      )));
    }
    if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
    else await writeJsonStdout(data, { pretty: true });
  } catch (error) {
    const { code, message } = projectAccountSecurityFailure(error);
    if (wantsJson(args)) await printJsonEnvelope({ ok: false, kind, error: { code, message } });
    else { console.error(message); process.exitCode = 1; }
  }
}

export async function handleAuthSecurityGet(args: string[], signal?: AbortSignal): Promise<void> {
  const kind = 'auth_security_get';
  try {
    args = await applyServerSelectionFromArgs(args);
    signal?.throwIfAborted();
    const subcommand = args[0];
    if (args.includes('--help') || args.includes('-h')) {
      console.log('Usage: happier auth security get [--json]');
      return;
    }
    if (subcommand !== 'get') {
      console.error('Usage: happier auth security get [--json]');
      process.exitCode = 1;
      return;
    }
    assertCommandArguments(args, {
      usage: 'Usage: happier auth security get [--json]',
      startIndex: 1,
      booleanFlags: ['--json'],
      valueFlags: [],
      maxPositionals: 0,
    });
    const credentials = await readStoredCredentials();
    if (!credentials) throw new AccountSecurityCommandError('not_authenticated');
    // The safe projection is intentionally readable with either interactive
    // credentials or a PAT. Mutations below retain the stricter provenance
    // check. PAT reads use the canonical authenticated route directly; the
    // shared Action remains the interactive host adapter for the same owner.
    const data = await readSelectedAccountSecurity(credentials, signal);
    if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
    else await writeJsonStdout(data, { pretty: true });
  } catch (error) {
    const { code, message } = projectAccountSecurityFailure(error);
    if (wantsJson(args)) await printJsonEnvelope({ ok: false, kind, error: { code, message } });
    else {
      console.error(message);
      process.exitCode = 1;
    }
  }
}

export async function handleAuthPasswordCommand(args: string[], signal?: AbortSignal): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === 'help' || args.includes('--help')) {
    console.log(ACCOUNT_SECURITY_USAGE);
    return;
  }
  if (subcommand === 'change') await handleAuthPasswordChange(args.slice(1), signal);
  else if (subcommand === 'remove') await handleAuthPasswordRemove(args.slice(1), signal);
  else if (subcommand === 'enroll-email-request') await handleAuthPasswordEnrollEmailRequest(args.slice(1), signal);
  else if (subcommand === 'enroll') await handleAuthPasswordEnroll(args.slice(1), signal);
  else {
    console.error(ACCOUNT_SECURITY_USAGE);
    process.exitCode = 1;
  }
}

async function handleAuthPasswordEnrollEmailRequest(args: string[], signal?: AbortSignal): Promise<void> {
  const kind = 'auth_password_enroll_email_request';
  const jsonRequested = wantsJson(args);
  try {
    args = await applyServerSelectionFromArgs(args);
    signal?.throwIfAborted();
    assertCommandArguments(args, {
      usage: 'Usage: happier auth password enroll-email-request --email <email> [--json]',
      startIndex: 0,
      booleanFlags: ['--json'],
      valueFlags: ['--email'],
      maxPositionals: 0,
    });
    const credentials = await readStoredCredentials();
    if (!credentials) throw new AccountSecurityCommandError('not_authenticated');
    if (!hasStoredSessionCredentialProvenance(credentials)) {
      throw new AccountSecurityCommandError('present_user_required');
    }
    const request = AccountPasswordEnrollEmailRequestV1Schema.parse({
      v: 1,
      email: readFlagValue(args, '--email') ?? '',
    });
    const response = await axios.post<unknown>(
      `${configuration.apiServerUrl}${ACCOUNT_PASSWORD_ENROLL_EMAIL_REQUEST_PATH_V1}`,
      request,
      {
        headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
        timeout: 30_000,
        ...(signal ? { signal } : {}),
        validateStatus: () => true,
      },
    );
    signal?.throwIfAborted();
    if (response.status < 200 || response.status >= 300) {
      const parsed = AccountSecurityRouteErrorV1Schema.safeParse(response.data);
      throw new AccountSecurityCommandError(
        parsed.success ? parsed.data.error : 'account_security_operation_failed',
      );
    }
    const data = AccountEmailChangeRequestResponseV1Schema.parse(response.data);
    if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
    else console.log(`Verification sent to ${request.email}.`);
  } catch (error) {
    const failure = projectAccountSecurityFailure(error);
    if (jsonRequested || wantsJson(args)) {
      await printJsonEnvelope({ ok: false, kind, error: failure });
    } else {
      console.error(failure.message);
      process.exitCode = 1;
    }
  }
}

async function handleAuthPasswordChange(args: string[], signal?: AbortSignal): Promise<void> {
  const kind = 'auth_password_change';
  // Capture the full argv for --json detection in the failure path before
  // server-selection strips Home-routing flags.
  const jsonRequested = wantsJson(args);
  try {
    args = await applyServerSelectionFromArgs(args);
    signal?.throwIfAborted();
    assertCommandArguments(args, {
      usage: 'Usage: happier auth password change [--current-password <password>] --new-password <password> [--revision <n>] [--recover] [--yes] [--json]',
      startIndex: 0,
      booleanFlags: ['--json', '--yes', '--recover'],
      valueFlags: ['--current-password', '--new-password', '--revision'],
      maxPositionals: 0,
    });
    const credentials = await readStoredCredentials();
    if (!credentials) throw new AccountSecurityCommandError('not_authenticated');
    if (!hasStoredSessionCredentialProvenance(credentials)) {
      throw new AccountSecurityCommandError('present_user_required');
    }
    const newPassword = await readSecretFlagOrPrompt(args, '--new-password', 'New password: ');
    const revisionRaw = readFlagValue(args, '--revision');
    const expectedCredentialRevision = revisionRaw ? Number.parseInt(revisionRaw, 10) : null;
    await confirmDangerousAction('Change the Account password on the selected Home?', args);
    const runtime = await createAccountSecurityActionRuntime(credentials, signal, 'account.password.change');
    const security = await readAccountSecurityProjection(runtime);
    if (security.password.status !== 'enrolled') {
      throw new AccountSecurityCommandError('account_security_operation_failed');
    }
    let request: ReturnType<typeof AccountPasswordChangeRequestV1Schema.parse>;
    if (security.encryptionMode === 'e2ee') {
      const secret = requireRecoverySecret(credentials);
      const normalizedNativeEmail = normalizeSecurityEmail(security.nativeEmail);
      const { prepareNativeEmailPasswordCredential } = await import('@/auth/nativeEmailPasswordCrypto');
      const preparedCredential = await prepareNativeEmailPasswordCredential({
        password: newPassword,
        secret,
        ...(signal ? { signal } : {}),
      });
      const preparation = await preparePasswordMutation(runtime, credentials, {
        v: 1,
        action: args.includes('--recover') ? 'recover' : 'change',
        expectedCredentialRevision: expectedCredentialRevision ?? security.password.revision,
        normalizedNativeEmail,
        newE2eePassword: {
          envelope: preparedCredential.envelope,
          authKey: preparedCredential.authKey,
        },
      }, signal);
      request = buildE2eeAccountPasswordChangeRequestV1({
        action: args.includes('--recover') ? 'recover' : 'change',
        accountId: await resolveAccountId(runtime, credentials, signal),
        normalizedNativeEmail,
        expectedCredentialRevision: expectedCredentialRevision ?? security.password.revision,
        recoverySecret: secret,
        expectedAudience: await resolveMutationAudience(runtime, credentials, signal),
        expectedEnvelope: preparedCredential.envelope,
        preparation,
      });
    } else {
      const currentPassword = await readSecretFlagOrPrompt(args, '--current-password', 'Current password: ');
      request = AccountPasswordChangeRequestV1Schema.parse({
        v: 1,
        kind: 'plain',
        expectedCredentialRevision: expectedCredentialRevision ?? security.password.revision,
        currentPassword,
        newPassword,
      });
    }
    // The exact completed CLI confirmation is host context, not Action input.
    // Shared policy consumes it only for this Action and still honors an
    // explicit configured approval requirement.
    const data = unwrap(await runtime.executor.execute('account.password.change', request, runtime.mutationContext));
    if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
    else await writeJsonStdout(data, { pretty: true });
  } catch (error) {
    const failure = projectAccountSecurityFailure(error);
    const { code } = failure;
    const message = failure.code === 'account_security_operation_failed'
      ? 'The password change failed.'
      : failure.message;
    if (jsonRequested || wantsJson(args)) await printJsonEnvelope({ ok: false, kind, error: { code, message } });
    else {
      console.error(message);
      process.exitCode = 1;
    }
  }
}

async function handleAuthPasswordRemove(args: string[], signal?: AbortSignal): Promise<void> {
  const kind = 'auth_password_remove';
  const jsonRequested = wantsJson(args);
  try {
    args = await applyServerSelectionFromArgs(args);
    signal?.throwIfAborted();
    assertCommandArguments(args, {
      usage: 'Usage: happier auth password remove [--current-password <password>] [--revision <n>] [--yes] [--json]',
      startIndex: 0,
      booleanFlags: ['--json', '--yes'],
      valueFlags: ['--current-password', '--revision'],
      maxPositionals: 0,
    });
    const credentials = await readStoredCredentials();
    if (!credentials) throw new AccountSecurityCommandError('not_authenticated');
    if (!hasStoredSessionCredentialProvenance(credentials)) {
      throw new AccountSecurityCommandError('present_user_required');
    }
    const revisionRaw = readFlagValue(args, '--revision');
    await confirmDangerousAction(
      'Remove email/password sign-in? The Account keeps another viable sign-in route or this fails.',
      args,
    );
    const runtime = await createAccountSecurityActionRuntime(credentials, signal, 'account.password.remove');
    const security = await readAccountSecurityProjection(runtime);
    if (security.password.status !== 'enrolled') {
      throw new AccountSecurityCommandError('account_security_operation_failed');
    }
    let request: ReturnType<typeof AccountPasswordRemoveRequestV1Schema.parse>;
    if (security.encryptionMode === 'e2ee') {
      const secret = requireRecoverySecret(credentials);
      const expectedCredentialRevision = revisionRaw
        ? Number.parseInt(revisionRaw, 10)
        : security.password.revision;
      const preparation = await preparePasswordMutation(runtime, credentials, {
        v: 1,
        action: 'remove',
        expectedCredentialRevision,
        normalizedNativeEmail: normalizeSecurityEmail(security.nativeEmail),
      }, signal);
      request = buildE2eeAccountPasswordRemoveRequestV1({
        accountId: await resolveAccountId(runtime, credentials, signal),
        normalizedNativeEmail: normalizeSecurityEmail(security.nativeEmail),
        expectedCredentialRevision,
        recoverySecret: secret,
        expectedAudience: await resolveMutationAudience(runtime, credentials, signal),
        preparation,
      });
    } else {
      const currentPassword = await readSecretFlagOrPrompt(args, '--current-password', 'Current password: ');
      request = AccountPasswordRemoveRequestV1Schema.parse({
        v: 1,
        kind: 'plain',
        expectedCredentialRevision: revisionRaw
          ? Number.parseInt(revisionRaw, 10)
          : security.password.revision,
        currentPassword,
      });
    }
    const data = unwrap(await runtime.executor.execute('account.password.remove', request, runtime.mutationContext));
    if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
    else await writeJsonStdout(data, { pretty: true });
  } catch (error) {
    const failure = projectAccountSecurityFailure(error);
    const { code } = failure;
    const message = failure.code === 'account_security_operation_failed'
      ? 'Removing the password failed.'
      : failure.message;
    if (jsonRequested || wantsJson(args)) await printJsonEnvelope({ ok: false, kind, error: { code, message } });
    else {
      console.error(message);
      process.exitCode = 1;
    }
  }
}

async function handleAuthPasswordEnroll(args: string[], signal?: AbortSignal): Promise<void> {
  const kind = 'auth_password_enroll';
  const jsonRequested = wantsJson(args);
  try {
    args = await applyServerSelectionFromArgs(args);
    signal?.throwIfAborted();
    assertCommandArguments(args, {
      usage:
        'Usage: happier auth password enroll --email <email> --password <password> [--verification-token <token>] [--yes] [--json]',
      startIndex: 0,
      booleanFlags: ['--json', '--yes'],
      valueFlags: ['--email', '--password', '--verification-token'],
      maxPositionals: 0,
    });
    const credentials = await readStoredCredentials();
    if (!credentials) throw new AccountSecurityCommandError('not_authenticated');
    if (!hasStoredSessionCredentialProvenance(credentials)) {
      throw new AccountSecurityCommandError('present_user_required');
    }
    const email = readFlagValue(args, '--email');
    const verificationToken = readFlagValue(args, '--verification-token');
    const password = await readSecretFlagOrPrompt(args, '--password', 'New password: ');
    const normalizedEmail = email ? normalizeVerifiedEmail(email) : null;
    if (!normalizedEmail) throw new AccountSecurityCommandError('invalid_arguments', ACCOUNT_SECURITY_USAGE);
    await confirmDangerousAction('Add email/password sign-in to this Account?', args);
    const runtime = await createAccountSecurityActionRuntime(credentials, signal, 'account.password.enroll');
    const security = await readAccountSecurityProjection(runtime);
    if (security.password.status !== 'not_enrolled') {
      throw new AccountSecurityCommandError('account_security_operation_failed');
    }
    let request: ReturnType<typeof AccountPasswordEnrollRequestV1Schema.parse>;
    if (security.encryptionMode === 'e2ee') {
      const secret = requireRecoverySecret(credentials);
      const { prepareNativeEmailPasswordCredential } = await import('@/auth/nativeEmailPasswordCrypto');
      const preparedCredential = await prepareNativeEmailPasswordCredential({
        password,
        secret,
        ...(signal ? { signal } : {}),
      });
      const preparation = await preparePasswordMutation(runtime, credentials, {
        v: 1,
        action: 'connect',
        expectedCredentialRevision: null,
        normalizedNativeEmail: normalizedEmail.normalizedEmail,
        newE2eePassword: {
          envelope: preparedCredential.envelope,
          authKey: preparedCredential.authKey,
        },
      }, signal);
      request = buildE2eeAccountPasswordEnrollRequestV1({
        email: normalizedEmail.normalizedEmail,
        ...(verificationToken ? { verificationToken } : {}),
        accountId: await resolveAccountId(runtime, credentials, signal),
        normalizedNativeEmail: normalizedEmail.normalizedEmail,
        recoverySecret: secret,
        expectedAudience: await resolveMutationAudience(runtime, credentials, signal),
        expectedEnvelope: preparedCredential.envelope,
        preparation,
      });
    } else {
      const preparation = PasswordMutationPreparationResponseV1Schema.parse(
        await preparePasswordMutation(runtime, credentials, {
          v: 1,
          action: 'connect',
          expectedCredentialRevision: null,
          normalizedNativeEmail: normalizedEmail.normalizedEmail,
          newPlainPassword: password,
        }, signal),
      );
      if (!('targetCredential' in preparation) || preparation.targetCredential.kind !== 'plain_password_hash') {
        throw new AccountSecurityCommandError('account_security_operation_failed');
      }
      const profile = await resolveAccountProfile(runtime, credentials, signal);
      const requestDigest = createPasswordCredentialMutationDigestV1({
        v: 1,
        action: 'connect',
        accountId: profile.id,
        expectedCredentialRevision: null,
        normalizedNativeEmail: normalizedEmail.normalizedEmail,
        newCredentialDigest: createPasswordCredentialTargetDigestV1(preparation.targetCredential),
      });
      const externalAuthProof = await acquirePlainEnrollmentExternalAuthProof({
        runtime,
        credentials,
        linkedProviderIds: profile.linkedProviders.map((linked) => linked.id),
        requestDigest,
        ...(signal ? { signal } : {}),
      });
      request = AccountPasswordEnrollRequestV1Schema.parse({
        v: 1,
        kind: 'plain',
        email: normalizedEmail.normalizedEmail,
        targetCredential: preparation.targetCredential,
        ...(verificationToken ? { verificationToken } : {}),
        reauthentication: externalAuthProof,
      });
    }
    const data = unwrap(
      await runtime.executor.execute('account.password.enroll', request, runtime.mutationContext),
    );
    if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
    else await writeJsonStdout(data, { pretty: true });
  } catch (error) {
    const failure = projectAccountSecurityFailure(error);
    const { code } = failure;
    const message = failure.code === 'account_security_operation_failed'
      ? 'Enrolling a password failed.'
      : failure.message;
    if (jsonRequested || wantsJson(args)) await printJsonEnvelope({ ok: false, kind, error: { code, message } });
    else {
      console.error(message);
      process.exitCode = 1;
    }
  }
}

export async function handleAuthEmailCommand(args: string[], signal?: AbortSignal): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === 'help' || args.includes('--help')) {
    console.log(ACCOUNT_SECURITY_USAGE);
    return;
  }
  if (subcommand === 'change-request') await handleAuthEmailChangeRequest(args.slice(1), signal);
  else {
    console.error(ACCOUNT_SECURITY_USAGE);
    process.exitCode = 1;
  }
}

async function handleAuthEmailChangeRequest(args: string[], signal?: AbortSignal): Promise<void> {
  const kind = 'auth_email_change_request';
  const jsonRequested = wantsJson(args);
  try {
    args = await applyServerSelectionFromArgs(args);
    signal?.throwIfAborted();
    assertCommandArguments(args, {
      usage: 'Usage: happier auth email change-request --email <new-email> [--yes] [--json]',
      startIndex: 0,
      booleanFlags: ['--json', '--yes'],
      valueFlags: ['--email'],
      maxPositionals: 0,
    });
    const credentials = await readStoredCredentials();
    if (!credentials) throw new AccountSecurityCommandError('not_authenticated');
    if (!hasStoredSessionCredentialProvenance(credentials)) {
      throw new AccountSecurityCommandError('present_user_required');
    }
    const email = readFlagValue(args, '--email');
    const parsed = AccountEmailChangeRequestV1Schema.safeParse({ v: 1, email: email ?? '' });
    if (!parsed.success) throw new AccountSecurityCommandError('invalid_arguments', ACCOUNT_SECURITY_USAGE);
    // The pending verification presentation stays process-local; the server
    // RepeatKey operation remains the authority. No unverified address is
    // persisted by this command.
    await confirmDangerousAction(`Send sign-in-email verification to ${email}?`, args);
    const runtime = await createAccountSecurityActionRuntime(credentials, signal, 'account.email.change.request');
    const data = unwrap(
      await runtime.executor.execute('account.email.change.request', parsed.data, runtime.mutationContext),
    );
    if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
    else await writeJsonStdout(data, { pretty: true });
  } catch (error) {
    const failure = projectAccountSecurityFailure(error);
    const { code } = failure;
    const message = failure.code === 'account_security_operation_failed'
      ? 'Requesting the email change failed.'
      : failure.message;
    if (jsonRequested || wantsJson(args)) await printJsonEnvelope({ ok: false, kind, error: { code, message } });
    else {
      console.error(message);
      process.exitCode = 1;
    }
  }
}
