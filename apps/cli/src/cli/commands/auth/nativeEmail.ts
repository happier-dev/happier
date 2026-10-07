import axios from 'axios';
import { randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';

import { NATIVE_AUTH_EMAIL_PRELOGIN_PATH_V1, NATIVE_AUTH_EMAIL_LOGIN_PATH_V1, NATIVE_AUTH_EMAIL_UNLOCK_PATH_V1, NATIVE_AUTH_EMAIL_PROVISION_PATH_V1, NATIVE_AUTH_EMAIL_VERIFY_REQUEST_PATH_V1, NATIVE_AUTH_PASSWORD_RESET_REQUEST_PATH_V1, NativeAuthEmailAcceptedResponseV1Schema, NativeEmailVerifyRequestV1Schema, NativePasswordResetRequestV1Schema, NativeEmailPasswordLoginResponseV1Schema, NativeEmailPasswordErrorResponseV1Schema, NativeEmailPasswordLoginRequestV1Schema, NativeEmailPasswordPreloginRequestV1Schema, NativeEmailPasswordPreloginResponseV1Schema, NativeEmailPasswordUnlockRequestV1Schema, NativeEmailPasswordUnlockResponseV1Schema, NativeEmailPasswordProvisionRequestV1Schema, NativeEmailPasswordProvisionResponseV1Schema } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';
import { NATIVE_AUTH_PASSWORD_RESET_SUBMIT_PATH_V1, PlainPasswordResetSubmitResponseV1Schema, PlainPasswordResetSubmitRequestV1Schema, ACCOUNT_EMAIL_CHANGE_PATH_V1, AccountSecurityRouteErrorV1Schema, AccountPasswordMutationResponseV1Schema, AccountEmailChangeCompleteRequestV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { normalizeVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';
import { parseRecoveryKey, formatRecoveryKey } from '@happier-dev/protocol/auth/recoveryKey';
import { KeyChallengeV2AuthRequestSchema, KeyChallengeV2IssueResponseSchema, canonicalizeKeyChallengeV2AudienceOrigin, createKeyChallengeV2SigningInput } from '@happier-dev/protocol/auth/keyChallenge';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { encodePasswordCredentialFieldV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { redactBugReportSensitiveText, registerSensitiveDiagnosticValues, type SensitiveDiagnosticValuesLease } from '@happier-dev/protocol/bugs/reports/redaction';

import { createHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { hasStoredSessionCredentialProvenance, readStoredCredentials, writeCredentialsLegacy, writeCredentialsTokenOnly } from '@/persistence';
import {
  deriveNativeEmailPasswordKeys,
  openNativeEmailPasswordEnvelope,
  passwordEnvelopeKdfsEqual,
  prepareNativeEmailPasswordCredential,
} from '@/auth/nativeEmailPasswordCrypto';
import { assertCommandArguments, readFlagValue, readRawFlagValue } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope, wantsJson, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { promptSecretInput } from '@/terminal/prompts/promptInput';
import { logger } from '@/ui/logger';
import { projectSafeAuthError } from './errorDiagnostic';

export const NATIVE_EMAIL_USAGE = [
  'Usage:',
  '  happier auth email login --email <email> --password <password> [--invitation-token <token>] [--json]',
  '  happier auth email provision --email <email> --password <password> --mode plain|e2ee --verification-token <token> [--invitation-token <token>] [--json]',
  '  happier auth email provision --email <email> [--json]   (requests mailbox verification; no Account is created yet)',
  '  happier auth email connect --email <email> --password <password> [--verification-token <token>] [--yes] [--json]   (enters Account Security enrollment)',
  '  happier auth email verify-request --email <email> [--json]',
  '  happier auth email reset-request --email <email> [--json]',
  '  happier auth email reset-submit --token <bearer> --new-password <password> [--json]',
  '  happier auth email change-request --email <new-email> [--yes] [--json]   (authenticated; sends verification)',
  '  happier auth email change-complete --verification-token <token> [--json]   (authenticated; consumes verification)',
  '  happier auth recovery-key validate --key <recovery-key> [--json]',
  '  happier auth recovery-key login --key <recovery-key> [--json]',
].join('\n');

class NativeEmailCommandError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    const messages: Readonly<Record<string, string>> = {
      unsupported: 'This Home does not support this operation. Update it and try again.',
      not_authenticated: 'Run happier auth login for the selected Home first.',
      present_user_required:
        'Use the selected Home\u2019s stored interactive login. API tokens cannot change email or passwords.',
      invalid_arguments: NATIVE_EMAIL_USAGE,
      authentication_failed: 'Sign-in failed. Check the email and password, then try again.',
      cancelled: 'The email operation was cancelled before any change began.',
      'account-disabled': 'This Account is disabled. Contact a Home administrator.',
      'method_not_available': 'Email/password is not available for this operation on the selected Home.',
      'invalid-token': 'This link is invalid, expired, or already used. Request a new one.',
      'not-eligible': 'This operation is no longer eligible. Return to the selected Home and try again.',
      password_hash_overloaded: 'The Home is temporarily unable to process passwords. Try again shortly.',
      challenge_unavailable: 'The Home could not issue the required key challenge. Try again.',
      invalid_reset: 'This password reset link is invalid, expired, or already used. Request a new one.',
      verification_invalid: 'This email verification link is invalid, expired, or already used. Request a new one.',
    };
    super(message ?? messages[code] ?? code);
  }
}

function throwNativeResponseFailure(data: unknown, fallback = 'authentication_failed'): never {
  const parsed = NativeEmailPasswordErrorResponseV1Schema.safeParse(data);
  if (!parsed.success) throw new NativeEmailCommandError(fallback);
  if (parsed.data.error === 'provider-required') {
    throw new NativeEmailCommandError(
      'provider-required',
      `This Account requires ${parsed.data.provider} authentication for this operation.`,
    );
  }
  throw new NativeEmailCommandError(parsed.data.error);
}

function throwAccountSecurityResponseFailure(data: unknown, fallback = 'authentication_failed'): never {
  const parsed = AccountSecurityRouteErrorV1Schema.safeParse(data);
  if (!parsed.success) throw new NativeEmailCommandError(fallback);
  if (parsed.data.error === 'provider-required') {
    throw new NativeEmailCommandError(
      'provider-required',
      `This Account requires ${parsed.data.provider} authentication for this operation.`,
    );
  }
  throw new NativeEmailCommandError(parsed.data.error);
}

function projectNativeCommandFailure(error: unknown, fallback: string): Readonly<{ code: string; message: string }> {
  if (error instanceof NativeEmailCommandError) return { code: error.code, message: error.message };
  if (
    (error instanceof Error && error.name === 'AbortError')
    || (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_CANCELED')
  ) {
    return { code: 'cancelled', message: 'The operation was cancelled before a local result was accepted.' };
  }
  return { code: fallback, message: fallback === 'authentication_failed' ? 'Authentication failed.' : 'The operation failed.' };
}

type CapturedNativeAttempt = Readonly<{
  serverId: string;
  serverUrl: string;
  serverApiUrl: string;
  serverIdentityId: string;
  normalizedEmail: string;
  invitationToken: string | null;
}>;

function readSecretFlagOrPrompt(args: readonly string[], flag: string, prompt: string, jsonMode: boolean): Promise<string> {
  // Secret values are never identifier-shaped CLI data. In particular,
  // password bytes must not be trimmed or normalized before the canonical
  // password acceptance owner receives them.
  const direct = readRawFlagValue(args, flag);
  if (direct && direct.length > 0) return Promise.resolve(direct);
  if (jsonMode) {
    throw new NativeEmailCommandError(
      'invalid_arguments',
      `Option ${flag} requires a value in --json mode. Pass ${flag} <value>.`,
    );
  }
  return promptSecretInput(prompt).then((entered) => {
    if (!entered) throw new NativeEmailCommandError('invalid_arguments', NATIVE_EMAIL_USAGE);
    return entered;
  });
}

function assertStillCaptured(captured: CapturedNativeAttempt): void {
  // Late work from another Home or email cannot authenticate this attempt.
  // Server selection is process-global; a concurrent selection change between
  // prelogin and credential persistence must not land credentials for the
  // wrong Home.
  if (
    configuration.activeServerId !== captured.serverId
    || configuration.serverUrl !== captured.serverUrl
    || resolveServerHttpBaseUrl() !== captured.serverApiUrl
  ) {
    throw new NativeEmailCommandError(
      'cancelled',
      'The selected Home changed during sign-in. Credentials were not changed; run the command again for the intended Home.',
    );
  }
}

async function captureNativeAttempt(args: readonly string[], email: string): Promise<CapturedNativeAttempt> {
  const normalized = normalizeVerifiedEmail(email);
  if (!normalized) throw new NativeEmailCommandError('invalid_arguments', NATIVE_EMAIL_USAGE);
  const serverId = configuration.activeServerId;
  const serverUrl = configuration.serverUrl;
  const serverApiUrl = resolveServerHttpBaseUrl();
  const snapshot = await fetchServerFeaturesSnapshot({ serverUrl: serverApiUrl });
  const serverIdentityId =
    snapshot.status === 'ready' ? snapshot.features.capabilities.serverIdentity.serverIdentityId?.trim() ?? '' : '';
  if (!serverIdentityId) throw new NativeEmailCommandError('unsupported');
  const invitationToken = readFlagValue(args, '--invitation-token');
  return {
    serverId,
    serverUrl,
    serverApiUrl,
    serverIdentityId,
    normalizedEmail: normalized.normalizedEmail,
    invitationToken: invitationToken && invitationToken.length > 0 ? invitationToken : null,
  };
}

async function postNative(params: Readonly<{
  path: string;
  body: unknown;
  serverApiUrl: string;
  signal?: AbortSignal;
}>): Promise<{ status: number; data: unknown }> {
  const response = await axios.post<unknown>(`${params.serverApiUrl}${params.path}`, params.body, {
    headers: { 'Content-Type': 'application/json' },
    ...(params.signal ? { signal: params.signal } : {}),
    validateStatus: () => true,
  });
  return { status: response.status, data: response.data };
}

async function redeemNativePasswordChallenge(input: Readonly<{
  captured: CapturedNativeAttempt;
  expectedAccountId?: string;
  requireExistingAccount?: true;
  challenge: import('@happier-dev/protocol').KeyChallengeV2IssueResponse;
  secret: Uint8Array;
  signal?: AbortSignal;
}>): Promise<string> {
  const expectedOrigin = canonicalizeKeyChallengeV2AudienceOrigin(input.captured.serverUrl);
  if (
    !expectedOrigin
    || input.challenge.audience.origin !== expectedOrigin
    || input.challenge.audience.serverIdentityId !== input.captured.serverIdentityId
  ) {
    throw new NativeEmailCommandError('authentication_failed');
  }
  const keyPair = tweetnacl.sign.keyPair.fromSeed(input.secret);
  const contentPrivateKey = deriveAccountMachineKeyFromRecoverySecret(input.secret);
  const contentPublicKey = tweetnacl.box.keyPair.fromSecretKey(contentPrivateKey).publicKey;
  contentPrivateKey.fill(0);
  const contentPublicKeySig = signAccountContentKeyBindingV1({
    accountSigningSecretKey: keyPair.secretKey,
    contentPublicKey,
  });
  const signingInput = createKeyChallengeV2SigningInput({
    ...input.challenge,
    ...(input.expectedAccountId ? { expectedAccountId: input.expectedAccountId } : {}),
    ...(input.requireExistingAccount ? { requireExistingAccount: true } : {}),
  });
  const request = KeyChallengeV2AuthRequestSchema.parse({
    credentialKind: 'terminal',
    challengeId: input.challenge.challengeId,
    publicKey: encodeBase64(keyPair.publicKey),
    signature: encodeBase64(tweetnacl.sign.detached(signingInput, keyPair.secretKey)),
    contentPublicKey: encodeBase64(contentPublicKey),
    contentPublicKeySig: encodeBase64(contentPublicKeySig),
    ...(input.expectedAccountId ? { expectedAccountId: input.expectedAccountId } : {}),
    ...(input.requireExistingAccount ? { requireExistingAccount: true } : {}),
  });
  const response = await postNative({
    path: '/v1/auth',
    body: request,
    serverApiUrl: input.captured.serverApiUrl,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (response.status < 200 || response.status >= 300) {
    throwNativeResponseFailure(response.data);
  }
  // /v1/auth includes `success: true`; the native-email finalizer's response
  // schema is strict and only describes its own { token } endpoint.
  return NativeEmailPasswordLoginResponseV1Schema.passthrough().parse(response.data).token;
}

/** Verified existing-Account sign-in shared by explicit recovery and retained-secret repair. */
export async function authenticateExistingAccountWithLegacySecret(input: Readonly<{
  secret: Uint8Array;
  serverApiUrl: string;
  serverIdentityId: string;
  signal?: AbortSignal;
}>): Promise<string> {
  const captured: CapturedNativeAttempt = {
    serverId: configuration.activeServerId,
    serverUrl: configuration.serverUrl,
    serverApiUrl: input.serverApiUrl,
    serverIdentityId: input.serverIdentityId,
    normalizedEmail: '',
    invitationToken: null,
  };
  const issued = await postNative({
    path: '/v1/auth/challenge',
    body: {},
    serverApiUrl: input.serverApiUrl,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (issued.status < 200 || issued.status >= 300) throw new NativeEmailCommandError('authentication_failed');
  const challenge = KeyChallengeV2IssueResponseSchema.parse(issued.data);
  assertStillCaptured(captured);
  const token = await redeemNativePasswordChallenge({
    captured,
    challenge,
    secret: input.secret,
    requireExistingAccount: true,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  assertStillCaptured(captured);
  return token;
}

export async function handleAuthEmailNativeCommand(args: string[], signal?: AbortSignal): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === 'help' || args.includes('--help')) {
    console.log(NATIVE_EMAIL_USAGE);
    return;
  }
  // Exhaustive dispatch by action ID. email_password never falls through to
  // mTLS or OAuth; unknown variants fail with a typed no-effect result.
  switch (subcommand) {
    case 'login':
      await handleNativeLogin(args.slice(1), signal);
      return;
    case 'provision':
      await handleNativeProvision(args.slice(1), signal);
      return;
    case 'connect':
      await handleNativeConnect(args.slice(1), signal);
      return;
    case 'verify-request':
      await handleVerifyRequest(args.slice(1), signal);
      return;
    case 'reset-request':
      await handleResetRequest(args.slice(1), signal);
      return;
    case 'reset-submit':
      await handleResetSubmit(args.slice(1), signal);
      return;
    case 'recovery-key':
      await handleRecoveryKey(args.slice(1), signal);
      return;
    case 'change-complete':
      await handleEmailChangeComplete(args.slice(1), signal);
      return;
    case 'change-request':
      await (await import('./accountSecurity.js')).handleAuthEmailCommand(['change-request', ...args.slice(1)], signal);
      return;
    default:
      console.error(NATIVE_EMAIL_USAGE);
      process.exitCode = 1;
  }
}

async function handleNativeLogin(args: string[], signal?: AbortSignal): Promise<void> {
  const kind = 'auth_email_login';
  const jsonRequested = wantsJson(args);
  try {
    args = await applyServerSelectionFromArgs(args);
    signal?.throwIfAborted();
    assertCommandArguments(args, {
      usage: 'Usage: happier auth email login --email <email> --password <password> [--invitation-token <token>] [--json]',
      startIndex: 0,
      booleanFlags: ['--json'],
      valueFlags: ['--email', '--password', '--invitation-token'],
      maxPositionals: 0,
    });
    const emailFlag = readFlagValue(args, '--email');
    if (!emailFlag) throw new NativeEmailCommandError('invalid_arguments', NATIVE_EMAIL_USAGE);
    const captured = await captureNativeAttempt(args, emailFlag);
    const password = await readSecretFlagOrPrompt(args, '--password', 'Password: ', wantsJson(args));
    const preloginBody = NativeEmailPasswordPreloginRequestV1Schema.parse({ v: 1, email: emailFlag });
    const prelogin = await postNative({ path: NATIVE_AUTH_EMAIL_PRELOGIN_PATH_V1, body: preloginBody, serverApiUrl: captured.serverApiUrl, ...(signal ? { signal } : {}) });
    if (prelogin.status === 404 || prelogin.status === 501) throw new NativeEmailCommandError('unsupported');
    if (prelogin.status < 200 || prelogin.status >= 300) {
      if (isAuthenticationStatus(prelogin.status)) throw new NativeEmailCommandError('authentication_failed');
      throw createHttpStatusError(prelogin.status, `Prelogin failed (${prelogin.status})`);
    }
    const routing = NativeEmailPasswordPreloginResponseV1Schema.parse(prelogin.data);
    assertStillCaptured(captured);
    if (routing.kind === 'e2ee_password_unlock') {
      const keys = await deriveNativeEmailPasswordKeys({
        password,
        kdf: routing.kdf,
        ...(signal ? { signal } : {}),
      });
      let secret: Uint8Array | undefined;
      try {
        const unlockRequest = NativeEmailPasswordUnlockRequestV1Schema.parse({
          v: 1,
          email: emailFlag,
          authKey: encodePasswordCredentialFieldV1(keys.authKey),
        });
        keys.authKey.fill(0);
        const unlockResponse = await postNative({
          path: NATIVE_AUTH_EMAIL_UNLOCK_PATH_V1,
          body: unlockRequest,
          serverApiUrl: captured.serverApiUrl,
          ...(signal ? { signal } : {}),
        });
        if (unlockResponse.status < 200 || unlockResponse.status >= 300) throwNativeResponseFailure(unlockResponse.data);
        const unlocked = NativeEmailPasswordUnlockResponseV1Schema.parse(unlockResponse.data);
        assertStillCaptured(captured);
        if (!passwordEnvelopeKdfsEqual(routing.kdf, unlocked.envelope.kdf)) {
          throw new NativeEmailCommandError('authentication_failed');
        }
        secret = openNativeEmailPasswordEnvelope(unlocked.envelope, keys.wrapKey);
        keys.wrapKey.fill(0);
        const token = await redeemNativePasswordChallenge({
          captured,
          expectedAccountId: unlocked.expectedAccountId,
          challenge: unlocked.challenge,
          secret,
          ...(signal ? { signal } : {}),
        });
        assertStillCaptured(captured);
        const credentials = { token, encryption: { type: 'legacy' as const, secret } };
        const { registerMachineWithAuthenticatedHomeRuntime } = await import('@/ui/auth');
        const registration = await registerMachineWithAuthenticatedHomeRuntime({
          credentials,
          forceNew: true,
          runtimeOrigin: captured.serverApiUrl,
        });
        signal?.throwIfAborted();
        assertStillCaptured(captured);
        await writeCredentialsLegacy({ token, secret });
        const data = {
          accountId: unlocked.expectedAccountId,
          serverId: captured.serverId,
          machineId: registration.machineId,
          ...(captured.invitationToken ? { invitationTokenPreserved: true } : {}),
        };
        if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
        else {
          console.log('Authentication successful');
          console.log(`  Home: ${captured.serverId}`);
        }
        return;
      } finally {
        keys.authKey.fill(0);
        keys.wrapKey.fill(0);
        secret?.fill(0);
      }
    }
    if (routing.kind !== 'plain_password') throw new NativeEmailCommandError('unsupported');
    const loginRequest = NativeEmailPasswordLoginRequestV1Schema.parse({ v: 1, email: emailFlag, password, credentialKind: 'terminal' });
    const login = await postNative({
      path: NATIVE_AUTH_EMAIL_LOGIN_PATH_V1,
      body: loginRequest,
      serverApiUrl: captured.serverApiUrl,
      ...(signal ? { signal } : {}),
    });
    if (login.status === 404 || login.status === 501) throw new NativeEmailCommandError('unsupported');
    if (login.status < 200 || login.status >= 300) throwNativeResponseFailure(login.data);
    const { token } = NativeEmailPasswordLoginResponseV1Schema.parse(login.data);
    assertStillCaptured(captured);
    // Plain login issues the existing token-only credential; no recovery
    // secret or content key is fabricated for a keyless Account.
    const accountId = readAccountIdFromToken(token);
    // Captured continuation: exact Home identity plus the optional bounded
    // invitation reference survive into the stored result. Invitation
    // consumption stays with the Lane 01 owner; login never mints membership.
    const { registerMachineWithAuthenticatedHomeRuntime } = await import('@/ui/auth');
    const registration = await registerMachineWithAuthenticatedHomeRuntime({
      credentials: { encryption: null, token },
      forceNew: true,
      runtimeOrigin: captured.serverApiUrl,
    });
    signal?.throwIfAborted();
    assertStillCaptured(captured);
    await writeCredentialsTokenOnly({ token });
    const data = {
      accountId,
      serverId: captured.serverId,
      machineId: registration.machineId,
      ...(captured.invitationToken ? { invitationTokenPreserved: true } : {}),
    };
    if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
    else {
      console.log('Authentication successful');
      console.log(`  Home: ${captured.serverId}`);
      if (captured.invitationToken) console.log('  Invitation continuation preserved; complete Join from the invitation.');
    }
  } catch (error) {
    const { code, message } = projectNativeCommandFailure(error, 'authentication_failed');
    if (jsonRequested || wantsJson(args)) await printJsonEnvelope({ ok: false, kind, error: { code, message } });
    else {
      console.error(message);
      process.exitCode = 1;
    }
  }
}

async function handleNativeProvision(args: string[], signal?: AbortSignal): Promise<void> {
  const kind = 'auth_email_provision';
  const jsonRequested = wantsJson(args);
  let recoverySecret: Uint8Array | undefined;
  try {
    args = await applyServerSelectionFromArgs(args);
    signal?.throwIfAborted();
    assertCommandArguments(args, {
      usage:
        'Usage: happier auth email provision --email <email> [--mode plain|e2ee --password <password> --verification-token <token>] [--invitation-token <token>] [--json]',
      startIndex: 0,
      booleanFlags: ['--json'],
      valueFlags: ['--email', '--mode', '--password', '--verification-token', '--invitation-token'],
      maxPositionals: 0,
    });
    const emailFlag = readFlagValue(args, '--email');
    if (!emailFlag) throw new NativeEmailCommandError('invalid_arguments', NATIVE_EMAIL_USAGE);
    const mode = readFlagValue(args, '--mode') ?? 'plain';
    if (mode !== 'plain' && mode !== 'e2ee') throw new NativeEmailCommandError('invalid_arguments', NATIVE_EMAIL_USAGE);
    const verificationToken = readFlagValue(args, '--verification-token');
    const captured = await captureNativeAttempt(args, emailFlag);
    const suppliedPassword = readRawFlagValue(args, '--password');
    if (!verificationToken && suppliedPassword === null) {
      // Bounded authority: a verification proof authorizes exactly one bounded
      // admission. A transferable invitation must be carried into this request
      // so the Home can bind the proof to that exact invitation and mailbox;
      // the neutral response intentionally does not disclose invitation kind.
      // Requesting it creates no Account and enables no public signup.
      const requested = await postNative({
        path: NATIVE_AUTH_EMAIL_VERIFY_REQUEST_PATH_V1,
        body: NativeEmailVerifyRequestV1Schema.parse({
          v: 1,
          email: emailFlag,
          ...(captured.invitationToken
            ? { admission: { kind: 'team_invitation', token: captured.invitationToken } }
            : {}),
        }),
        serverApiUrl: captured.serverApiUrl,
        ...(signal ? { signal } : {}),
      });
      if (requested.status === 404 || requested.status === 501) throw new NativeEmailCommandError('unsupported');
      NativeAuthEmailAcceptedResponseV1Schema.parse(requested.data);
      assertStillCaptured(captured);
      const data = { verificationRequested: true, serverId: captured.serverId };
      if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
      else {
        console.log(`Verification sent to ${captured.normalizedEmail}. Re-run with --verification-token <token> from the email.`);
      }
      return;
    }
    const password = await readSecretFlagOrPrompt(args, '--password', 'Choose a password: ', wantsJson(args));
    // Strict must-create provision: the shared Account-insert owner never
    // reuses a pre-existing Account, public key, or identity. Email-bound
    // admission proves only the exact invited mailbox; transferable admission
    // requires its separate mailbox proof. Neither mints arbitrary evidence;
    // mismatches fail closed with zero partial rows.
    const admission = captured.invitationToken
      ? {
          kind: 'team_invitation' as const,
          token: captured.invitationToken,
          ...(verificationToken ? { emailVerificationToken: verificationToken } : {}),
        }
      : { kind: 'native_email_verification' as const, token: verificationToken ?? '' };
    if (!captured.invitationToken && !verificationToken) throw new NativeEmailCommandError('invalid_arguments', NATIVE_EMAIL_USAGE);
    let provisionRequest: ReturnType<typeof NativeEmailPasswordProvisionRequestV1Schema.parse>;
    if (mode === 'plain') {
      provisionRequest = NativeEmailPasswordProvisionRequestV1Schema.parse({
        v: 1,
        credentialKind: 'terminal',
        email: emailFlag,
        admission,
        account: { mode: 'plain', password },
      });
    } else {
      recoverySecret = new Uint8Array(randomBytes(32));
      const prepared = await prepareNativeEmailPasswordCredential({
        password,
        secret: recoverySecret,
        ...(signal ? { signal } : {}),
      });
      const issued = await postNative({
        path: '/v1/auth/challenge',
        body: {},
        serverApiUrl: captured.serverApiUrl,
        ...(signal ? { signal } : {}),
      });
      if (issued.status < 200 || issued.status >= 300) throwNativeResponseFailure(issued.data, 'challenge_unavailable');
      const challenge = KeyChallengeV2IssueResponseSchema.parse(issued.data);
      const expectedOrigin = canonicalizeKeyChallengeV2AudienceOrigin(captured.serverUrl);
      if (
        !expectedOrigin
        || challenge.audience.origin !== expectedOrigin
        || challenge.audience.serverIdentityId !== captured.serverIdentityId
      ) {
        throw new NativeEmailCommandError('authentication_failed');
      }
      const signingKeyPair = tweetnacl.sign.keyPair.fromSeed(recoverySecret);
      try {
        provisionRequest = NativeEmailPasswordProvisionRequestV1Schema.parse({
          v: 1,
          credentialKind: 'terminal',
          email: emailFlag,
          admission,
          account: {
            mode: 'e2ee',
            authKey: prepared.authKey,
            envelope: prepared.envelope,
            proof: {
              challengeId: challenge.challengeId,
              publicKey: encodeBase64(signingKeyPair.publicKey),
              signature: encodeBase64(tweetnacl.sign.detached(
                createKeyChallengeV2SigningInput(challenge),
                signingKeyPair.secretKey,
              )),
              contentPublicKey: prepared.contentPublicKey,
              contentPublicKeySig: prepared.contentPublicKeySig,
            },
          },
        });
      } finally {
        signingKeyPair.secretKey.fill(0);
      }
    }
    const provision = await postNative({
      path: NATIVE_AUTH_EMAIL_PROVISION_PATH_V1,
      body: provisionRequest,
      serverApiUrl: captured.serverApiUrl,
      ...(signal ? { signal } : {}),
    });
    if (provision.status === 404 || provision.status === 501) throw new NativeEmailCommandError('unsupported');
    if (provision.status < 200 || provision.status >= 300) throwNativeResponseFailure(provision.data);
    const created = NativeEmailPasswordProvisionResponseV1Schema.parse(provision.data);
    assertStillCaptured(captured);
    if (created.accountId.trim().length === 0 || created.token.trim().length === 0) {
      throw new NativeEmailCommandError('unsupported');
    }
    const credentials = recoverySecret
      ? { encryption: { type: 'legacy' as const, secret: recoverySecret }, token: created.token }
      : { encryption: null, token: created.token };
    const { registerMachineWithAuthenticatedHomeRuntime } = await import('@/ui/auth');
    const registration = await registerMachineWithAuthenticatedHomeRuntime({
      credentials,
      forceNew: true,
      runtimeOrigin: captured.serverApiUrl,
    });
    signal?.throwIfAborted();
    assertStillCaptured(captured);
    if (recoverySecret) await writeCredentialsLegacy({ token: created.token, secret: recoverySecret });
    else await writeCredentialsTokenOnly({ token: created.token });
    const data = {
      accountId: created.accountId,
      teamId: created.teamId,
      serverId: captured.serverId,
      machineId: registration.machineId,
      accountMode: mode,
      ...(recoverySecret ? { recoveryKey: formatRecoveryKey(recoverySecret) } : {}),
      ...(captured.invitationToken ? { invitationTokenPreserved: true } : {}),
    };
    if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
    else {
      console.log('Account created and authenticated');
      console.log(`  Home: ${captured.serverId}`);
      if (recoverySecret) {
        console.log(`  Recovery key (shown once): ${formatRecoveryKey(recoverySecret)}`);
        console.log('  Save it somewhere private before closing this terminal.');
      }
    }
  } catch (error) {
    const { code, message } = projectNativeCommandFailure(error, 'authentication_failed');
    if (jsonRequested || wantsJson(args)) await printJsonEnvelope({ ok: false, kind, error: { code, message } });
    else {
      console.error(message);
      process.exitCode = 1;
    }
  } finally {
    recoverySecret?.fill(0);
  }
}

async function handleNativeConnect(args: string[], signal?: AbortSignal): Promise<void> {
  // This is only an entry-point alias. Account Security remains the single
  // enrollment owner for Plain and E2EE Accounts.
  await (await import('./accountSecurity.js')).handleAuthPasswordCommand(['enroll', ...args], signal);
}

async function handleVerifyRequest(args: string[], signal?: AbortSignal): Promise<void> {
  const kind = 'auth_email_verify_request';
  const jsonRequested = wantsJson(args);
  try {
    args = await applyServerSelectionFromArgs(args);
    signal?.throwIfAborted();
    assertCommandArguments(args, {
      usage: 'Usage: happier auth email verify-request --email <email> [--json]',
      startIndex: 0,
      booleanFlags: ['--json'],
      valueFlags: ['--email'],
      maxPositionals: 0,
    });
    const email = readFlagValue(args, '--email');
    if (!email) throw new NativeEmailCommandError('invalid_arguments', NATIVE_EMAIL_USAGE);
    const captured = await captureNativeAttempt(args, email);
    const response = await postNative({
      path: NATIVE_AUTH_EMAIL_VERIFY_REQUEST_PATH_V1,
      body: NativeEmailVerifyRequestV1Schema.parse({ v: 1, email }),
      serverApiUrl: captured.serverApiUrl,
      ...(signal ? { signal } : {}),
    });
    if (response.status === 404 || response.status === 501) throw new NativeEmailCommandError('unsupported');
    // Existence-neutral: claimed, unknown, and ineligible addresses receive
    // the same accepted projection.
    const data = NativeAuthEmailAcceptedResponseV1Schema.parse(response.data);
    assertStillCaptured(captured);
    if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
    else await writeJsonStdout(data, { pretty: true });
  } catch (error) {
    const code = error instanceof NativeEmailCommandError ? error.code : 'authentication_failed';
    const message = error instanceof NativeEmailCommandError ? error.message : 'The request failed.';
    if (jsonRequested || wantsJson(args)) await printJsonEnvelope({ ok: false, kind, error: { code, message } });
    else {
      console.error(message);
      process.exitCode = 1;
    }
  }
}

async function handleResetRequest(args: string[], signal?: AbortSignal): Promise<void> {
  const kind = 'auth_password_reset_request';
  const jsonRequested = wantsJson(args);
  try {
    args = await applyServerSelectionFromArgs(args);
    signal?.throwIfAborted();
    assertCommandArguments(args, {
      usage: 'Usage: happier auth email reset-request --email <email> [--json]',
      startIndex: 0,
      booleanFlags: ['--json'],
      valueFlags: ['--email'],
      maxPositionals: 0,
    });
    const email = readFlagValue(args, '--email');
    if (!email) throw new NativeEmailCommandError('invalid_arguments', NATIVE_EMAIL_USAGE);
    const captured = await captureNativeAttempt(args, email);
    const response = await postNative({
      path: NATIVE_AUTH_PASSWORD_RESET_REQUEST_PATH_V1,
      body: NativePasswordResetRequestV1Schema.parse({ v: 1, email: captured.normalizedEmail }),
      serverApiUrl: captured.serverApiUrl,
      ...(signal ? { signal } : {}),
    });
    if (response.status === 404 || response.status === 501) throw new NativeEmailCommandError('unsupported');
    const data = NativeAuthEmailAcceptedResponseV1Schema.parse(response.data);
    assertStillCaptured(captured);
    if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
    else await writeJsonStdout(data, { pretty: true });
  } catch (error) {
    const code = error instanceof NativeEmailCommandError ? error.code : 'authentication_failed';
    const message = error instanceof NativeEmailCommandError ? error.message : 'The request failed.';
    if (jsonRequested || wantsJson(args)) await printJsonEnvelope({ ok: false, kind, error: { code, message } });
    else {
      console.error(message);
      process.exitCode = 1;
    }
  }
}

async function handleResetSubmit(args: string[], signal?: AbortSignal): Promise<void> {
  const kind = 'auth_password_reset_submit';
  const jsonRequested = wantsJson(args);
  try {
    args = await applyServerSelectionFromArgs(args);
    signal?.throwIfAborted();
    assertCommandArguments(args, {
      usage: 'Usage: happier auth email reset-submit --token <bearer> --new-password <password> [--json]',
      startIndex: 0,
      booleanFlags: ['--json'],
      valueFlags: ['--token', '--new-password'],
      maxPositionals: 0,
    });
    const token = await readSecretFlagOrPrompt(args, '--token', 'Password reset token: ', wantsJson(args));
    const newPassword = await readSecretFlagOrPrompt(args, '--new-password', 'New password: ', wantsJson(args));
    const serverApiUrl = resolveServerHttpBaseUrl();
    const serverId = configuration.activeServerId;
    const response = await postNative({
      path: NATIVE_AUTH_PASSWORD_RESET_SUBMIT_PATH_V1,
      body: PlainPasswordResetSubmitRequestV1Schema.parse({ v: 1, token, password: newPassword }),
      serverApiUrl,
      ...(signal ? { signal } : {}),
    });
    if (response.status === 404 || response.status === 501) throw new NativeEmailCommandError('unsupported');
    if (response.status < 200 || response.status >= 300) throwAccountSecurityResponseFailure(response.data);
    const data = PlainPasswordResetSubmitResponseV1Schema.parse(response.data);
    void serverId;
    if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
    else await writeJsonStdout(data, { pretty: true });
  } catch (error) {
    const code = error instanceof NativeEmailCommandError ? error.code : 'authentication_failed';
    const message = error instanceof NativeEmailCommandError ? error.message : 'Password reset failed.';
    if (jsonRequested || wantsJson(args)) await printJsonEnvelope({ ok: false, kind, error: { code, message } });
    else {
      console.error(message);
      process.exitCode = 1;
    }
  }
}

async function handleEmailChangeComplete(args: string[], signal?: AbortSignal): Promise<void> {
  // The email-link confirmation remains the capability-bound auth continuation
  // route, not a sixth general Action. Its raw bearer never enters Action
  // history, agent context, or generic API/MCP inputs; it is consumed here
  // with the authenticated caller and exact-Home binding only.
  const kind = 'auth_email_change_complete';
  const jsonRequested = wantsJson(args);
  try {
    args = await applyServerSelectionFromArgs(args);
    signal?.throwIfAborted();
    assertCommandArguments(args, {
      usage: 'Usage: happier auth email change-complete --verification-token <token> [--json]',
      startIndex: 0,
      booleanFlags: ['--json'],
      valueFlags: ['--verification-token'],
      maxPositionals: 0,
    });
    const credentials = await readStoredCredentials();
    if (!credentials) throw new NativeEmailCommandError('not_authenticated', 'Run happier auth login for the selected Home first.');
    if (!hasStoredSessionCredentialProvenance(credentials)) {
      throw new NativeEmailCommandError('present_user_required', 'Use the selected Home\u2019s stored interactive login to change the sign-in email.');
    }
    const verificationToken = await readSecretFlagOrPrompt(
      args,
      '--verification-token',
      'Email verification token: ',
      wantsJson(args),
    );
    const serverApiUrl = resolveServerHttpBaseUrl();
    const serverId = configuration.activeServerId;
    const response = await axios.post<unknown>(
      `${serverApiUrl}${ACCOUNT_EMAIL_CHANGE_PATH_V1}`,
      AccountEmailChangeCompleteRequestV1Schema.parse({ v: 1, verificationToken }),
      {
        headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
        ...(signal ? { signal } : {}),
        validateStatus: () => true,
      },
    );
    if (response.status === 404 || response.status === 501) throw new NativeEmailCommandError('unsupported');
    if (isAuthenticationStatus(response.status)) throw new NativeEmailCommandError('not_authenticated', 'Run happier auth login for the selected Home first.');
    if (response.status < 200 || response.status >= 300) throwAccountSecurityResponseFailure(response.data);
    const data = AccountPasswordMutationResponseV1Schema.parse(response.data);
    void serverId;
    if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
    else await writeJsonStdout(data, { pretty: true });
  } catch (error) {
    const code = error instanceof NativeEmailCommandError ? error.code : 'authentication_failed';
    const message = error instanceof NativeEmailCommandError ? error.message : 'Email change failed.';
    if (jsonRequested || wantsJson(args)) await printJsonEnvelope({ ok: false, kind, error: { code, message } });
    else {
      console.error(message);
      process.exitCode = 1;
    }
  }
}

async function handleRecoveryKey(args: string[], signal?: AbortSignal): Promise<void> {
  const subcommand = args[0];
  if (subcommand === 'validate') {
    await (await import('./recoveryKey')).handleRecoveryKeyValidation(args.slice(1));
    return;
  }
  const kind = subcommand === 'login' ? 'auth_recovery_key_login' : 'auth_recovery_key_validate';
  const jsonRequested = wantsJson(args);
  let phase = 'arguments';
  const diagnosticLeases: SensitiveDiagnosticValuesLease[] = [];
  try {
    if (subcommand !== 'login') throw new NativeEmailCommandError('invalid_arguments', NATIVE_EMAIL_USAGE);
    if (subcommand === 'login') args = await applyServerSelectionFromArgs(args);
    const rest = subcommand === 'login' ? args.slice(1) : args;
    assertCommandArguments(rest, {
      usage: 'Usage: happier auth recovery-key <validate|login> --key <recovery-key> [--json]',
      startIndex: 0,
      booleanFlags: ['--json'],
      valueFlags: ['--key'],
      maxPositionals: 0,
    });
    const key = await readSecretFlagOrPrompt(rest, '--key', 'Recovery key: ', wantsJson(args));
    diagnosticLeases.push(registerSensitiveDiagnosticValues([key]));
    // Typed secret-safe recovery: reuse the canonical parser, never log or
    // return key material. A valid key proves format only; it never proves
    // Account identity or decrypts content on its own.
    const parsed = parseRecoveryKey(key);
    if (!parsed.ok) {
      const data = { ok: false as const, reason: parsed.reason };
      if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
      else {
        console.error(`Invalid recovery key (${parsed.reason}).`);
        process.exitCode = 1;
      }
      return;
    }
    if (subcommand === 'login') {
      diagnosticLeases.push(registerSensitiveDiagnosticValues([
        Buffer.from(parsed.bytes).toString('base64'),
        Buffer.from(parsed.bytes).toString('base64url'),
        Buffer.from(parsed.bytes).toString('hex'),
      ]));
      try {
        signal?.throwIfAborted();
        const serverApiUrl = resolveServerHttpBaseUrl();
        const serverId = configuration.activeServerId;
        const serverUrl = configuration.serverUrl;
        phase = 'home_features';
        const snapshot = await fetchServerFeaturesSnapshot({ serverUrl: serverApiUrl, ...(signal ? { signal } : {}) });
        const serverIdentityId = snapshot.status === 'ready'
          ? snapshot.features.capabilities.serverIdentity.serverIdentityId?.trim() ?? ''
          : '';
        if (!serverIdentityId) throw new NativeEmailCommandError('unsupported');
        const captured: CapturedNativeAttempt = {
          serverId,
          serverUrl,
          serverApiUrl,
          serverIdentityId,
          normalizedEmail: '',
          invitationToken: null,
        };
        phase = 'challenge_redemption';
        const token = await authenticateExistingAccountWithLegacySecret({
          secret: parsed.bytes,
          serverApiUrl,
          serverIdentityId,
          ...(signal ? { signal } : {}),
        });
        diagnosticLeases.push(registerSensitiveDiagnosticValues([token]));
        const credentials = { token, encryption: { type: 'legacy' as const, secret: parsed.bytes } };
        phase = 'machine_registration';
        const { registerMachineWithAuthenticatedHomeRuntime } = await import('@/ui/auth');
        const registration = await registerMachineWithAuthenticatedHomeRuntime({
          credentials,
          forceNew: true,
          runtimeOrigin: serverApiUrl,
        });
        signal?.throwIfAborted();
        assertStillCaptured(captured);
        phase = 'credential_persistence';
        await writeCredentialsLegacy({ token, secret: parsed.bytes });
        const accountId = readAccountIdFromToken(token);
        const data = { accountId, serverId, machineId: registration.machineId };
        if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
        else console.log('Recovery-key authentication successful.');
        return;
      } finally {
        parsed.bytes.fill(0);
      }
    }
    parsed.bytes.fill(0);
    throw new NativeEmailCommandError('invalid_arguments', NATIVE_EMAIL_USAGE);
  } catch (error) {
    const diagnostic = projectSafeAuthError(error);
    const code = redactBugReportSensitiveText(String(diagnostic.code ?? `recovery_key_${phase}_failed`));
    const message = error instanceof NativeEmailCommandError
      ? error.message
      : `Recovery-key login failed during ${phase} (${code}).`;
    // Only describe the real error's text and actionable fields. Never hand
    // axios config, headers, bodies, argv, or credentials to the logger.
    const stack = typeof error === 'object' && error !== null && 'stack' in error && typeof error.stack === 'string'
      ? redactBugReportSensitiveText(error.stack)
      : undefined;
    try {
      logger.warnLocalFile('[AUTH] Recovery-key login failed', {
        phase,
        ...(diagnostic.status ? { status: diagnostic.status } : {}),
        error: {
          ...diagnostic,
          name: redactBugReportSensitiveText(diagnostic.name),
          message: redactBugReportSensitiveText(diagnostic.message),
          code,
          ...(stack ? { stack } : {}),
        },
      });
      logger.flushSync();
    } catch {
      // Diagnostic I/O must not replace the originating failure.
    }
    if (jsonRequested || wantsJson(args)) await printJsonEnvelope({ ok: false, kind, error: { code, message, phase, ...(diagnostic.status ? { status: diagnostic.status } : {}) } });
    else {
      console.error(message);
      process.exitCode = 1;
    }
  } finally {
    for (const lease of diagnosticLeases) lease.close();
  }
}
