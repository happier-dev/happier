import { randomBytes, randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { AccountApiTokensCreateActionInputV1Schema, AccountApiTokensCreateActionOutputV1Schema, AccountApiTokensListActionOutputV1Schema, AccountApiTokensRevokeActionInputV1Schema, AccountApiTokensServerErrorV1Schema, formatAccountApiTokenCredentialV1, parseAccountApiTokenBearerV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { openApiTokenEncryptionAccessV1, wrapApiTokenEncryptionAccessV1 } from '@happier-dev/protocol/crypto/apiTokenEncryptionAccess';
import { isApiTokenGrantRestrictedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { ActionExecuteResult, AccountApiTokenSummaryV1 } from '@happier-dev/protocol';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

import { fetchAccountProfile } from '@/api/accountProfile';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { hasStoredSessionCredentialProvenance, readStoredCredentials, type StoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { assertCommandArguments, readCommandPositionals, readFlagValue } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope, wantsJson, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';

const USAGE = 'Usage: happier auth api-tokens create --label <label> [--expires-at <ISO date>] [--encryption] [--authorize-unattended-team-access] [--yes] | list | revoke <tokenId> [--yes] | revoke-all [--yes] [--json]';

class ApiTokenCommandError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    const messages: Readonly<Record<string, string>> = {
      unsupported: 'This Home does not support this operation. Update it or create an ordinary API token.',
      api_token_encryption_not_ready: 'Recover the selected Home’s current Account encryption material before creating an encryption-capable token.',
      api_token_encryption_stale: 'The local encryption material is stale. Recover the selected Home’s current Account material first.',
      api_token_id_conflict: 'The generated token ID already exists. Retry creation to generate a new ID.',
      credential_authentication_evidence_limit: 'This credential has too many authentication facts to copy safely. Re-authenticate with only the required method, then create the token again.',
      credential_authentication_evidence_unavailable: 'This signed-in credential has no current authentication evidence to authorize for unattended Team access. Re-authenticate with the required method, then create the token again.',
      not_authenticated: 'Run happier auth login for the selected Home first.',
      cancelled: 'The API-token operation was cancelled before creation began.',
      confirmation_declined: 'Confirmation declined. No API-token change was made.',
    };
    super(message ?? messages[code] ?? code);
  }
}

async function confirmDangerousApiTokenAction(message: string, args: readonly string[]): Promise<void> {
  if (args.includes('--yes')) return;
  if (args.includes('--json')) {
    throw new ApiTokenCommandError(
      'confirmation_declined',
      'Refusing an API-token change without confirmation. Re-run with --yes after reviewing the consequences.',
    );
  }
  const { promptConfirmYesNo } = await import('@/terminal/prompts/promptConfirmYesNo');
  const confirmed = await promptConfirmYesNo(message, { default: 'no' });
  if (!confirmed) throw new ApiTokenCommandError('confirmation_declined');
}

function unwrap(result: ActionExecuteResult): unknown {
  if (!result.ok) {
    const known = AccountApiTokensServerErrorV1Schema.shape.error.safeParse(result.errorCode);
    // Never propagate arbitrary Action/transport error text into auth DEBUG output.
    const code = known.success ? known.data : [
      'unsupported', 'unsupported_action', 'not_authenticated', 'action_disabled',
      'invalid_arguments', 'invalid_parameters', 'present_user_required',
      'approval_rejected', 'approval_canceled', 'cancelled', 'rate_limited',
      'server_target_mismatch', 'server_unreachable', 'outcome_unknown',
    ].includes(result.errorCode ?? '')
      ? result.errorCode! : 'api_token_operation_failed';
    throw new ApiTokenCommandError(code);
  }
  return result.result;
}

function formatTokenAccess(token: AccountApiTokenSummaryV1): string {
  const grant = token.grant;
  const parts = [isApiTokenGrantRestrictedV1(grant) ? 'Limited' : 'Full access'];
  if (grant.actions) parts.push(`${grant.actions.ids.length} Actions, ${grant.actions.families.length} families`);
  if (grant.targets) parts.push(`${grant.targets.sessions.length} sessions, ${grant.targets.machines.length} computers`);
  if (grant.models) parts.push(`${grant.models.length} models`);
  if (grant.permissionModes) parts.push(`${grant.permissionModes.length} permission modes`);
  if (grant.create) parts.push('managed creation');
  parts.push(grant.approve ? 'approvals on' : 'approvals off');
  if (grant.origins.length) parts.push(`${grant.origins.length} websites`);
  if (token.hasEncryptionAccess) parts.push('content access');
  return parts.join('; ');
}

function printTokenList(tokens: readonly AccountApiTokenSummaryV1[]): void {
  const rows = [
    ['Label', 'Token', 'Access', 'Expires'],
    ...tokens.map((token) => [token.label.replace(/\s+/gu, ' '), token.tokenId,
      formatTokenAccess(token), token.expiresAt ?? 'Never']),
  ];
  const widths = rows[0]!.map((_, index) => rows.reduce((width, row) => Math.max(width, row[index]!.length), 0));
  console.log(rows.map((row) => row.map((cell, index) => cell.padEnd(widths[index]!)).join('  ').trimEnd()).join('\n'));
}

async function prepareEncryption(
  credentials: StoredCredentials,
  serverUrl: string,
  tokenId: string,
  signal?: AbortSignal,
) {
  if (!credentials.encryption) throw new ApiTokenCommandError('api_token_encryption_not_ready');
  const [profile, currentness, features] = await Promise.all([
    fetchAccountProfile({ token: credentials.token, signal }),
    fetchAccountEncryptionCurrentness({ token: credentials.token, serverBaseUrl: serverUrl, signal }),
    fetchServerFeaturesSnapshot({ serverUrl, signal }),
  ]);
  const serverIdentityId = features.status === 'ready' ? features.features.capabilities.serverIdentity.serverIdentityId : null;
  if (!serverIdentityId) throw new ApiTokenCommandError('unsupported');
  if (currentness.mode !== 'e2ee' || !currentness.contentKeyFingerprint) throw new ApiTokenCommandError('api_token_encryption_not_ready');
  const material = credentials.encryption;
  if ((material.type === 'legacy' ? material.secret : material.machineKey).length !== 32) {
    throw new ApiTokenCommandError('api_token_encryption_not_ready');
  }
  const contentPrivateKey = material.type === 'legacy'
    ? deriveAccountMachineKeyFromRecoverySecret(material.secret)
    : new Uint8Array(material.machineKey);
  try {
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(contentPrivateKey).publicKey;
    if ((material.type === 'dataKey' && !tweetnacl.verify(material.publicKey, publicKey))
      || computeAccountEncryptionMigrateKeyFingerprintV1(publicKey) !== currentness.contentKeyFingerprint) {
      throw new ApiTokenCommandError('api_token_encryption_stale');
    }
    const context = { serverIdentityId, accountId: profile.id, tokenId, contentPublicKey: encodeBase64(publicKey) };
    const wrappingSecret = randomBytes(32);
    let wrappingSecretTransferred = false;
    try {
      const encryptionAccess = wrapApiTokenEncryptionAccessV1({ context, wrappingSecret, contentPrivateKey, randomBytes });
      const opened = openApiTokenEncryptionAccessV1({ context, wrappingSecret, encryptionAccess });
      if (!opened || !tweetnacl.verify(opened, contentPrivateKey)) throw new ApiTokenCommandError('api_token_encryption_not_ready');
      opened.fill(0);
      wrappingSecretTransferred = true;
      return { context, wrappingSecret, encryptionAccess };
    } finally {
      if (!wrappingSecretTransferred) wrappingSecret.fill(0);
    }
  } finally {
    contentPrivateKey.fill(0);
  }
}

export async function handleAuthApiTokens(args: string[], signal?: AbortSignal): Promise<void> {
  const kind = `auth_api_tokens_${args[0] ?? 'help'}`;
  let requestedTokenId: string | undefined;
  let outcomeUnknown = false;
  let createRequestStarted = false;
  try {
    args = await applyServerSelectionFromArgs(args);
    if (signal?.aborted) throw new ApiTokenCommandError('cancelled');
    const command = args[0];
    if (!command || args.includes('--help') || command === 'help') { console.log(USAGE); return; }
    if (!['create', 'list', 'revoke', 'revoke-all'].includes(command)) throw new ApiTokenCommandError('invalid_arguments', USAGE);
    assertCommandArguments(args, {
      usage: USAGE, startIndex: 1,
      booleanFlags: command === 'create'
        ? ['--json', '--encryption', '--authorize-unattended-team-access', '--yes']
        : command === 'list'
          ? ['--json']
          : ['--json', '--yes'],
      valueFlags: command === 'create' ? ['--label', '--expires-at'] : [],
      maxPositionals: command === 'revoke' ? 1 : 0,
    });
    const credentials = await readStoredCredentials();
    if (!credentials) throw new ApiTokenCommandError('not_authenticated', 'Run happier auth login first.');
    if (!hasStoredSessionCredentialProvenance(credentials)
      || credentials.token.startsWith('hapc_') || parseAccountApiTokenBearerV1(credentials.token)) {
      throw new ApiTokenCommandError('present_user_required', 'Use the selected Home’s stored interactive login to manage API tokens.');
    }
    if (command === 'create') {
      await confirmDangerousApiTokenAction('Create an API token for the selected Home?', args);
    } else if (command === 'revoke') {
      await confirmDangerousApiTokenAction('Revoke this API token on the selected Home?', args);
    } else if (command === 'revoke-all') {
      await confirmDangerousApiTokenAction('Revoke every API token on the selected Home?', args);
    }
    if (signal?.aborted) throw new ApiTokenCommandError('cancelled');
    const serverId = configuration.activeServerId;
    const serverUrl = configuration.apiServerUrl;
    const executor = createCliActionExecutorFromCredentials({
      credentials,
      serverId,
      serverApiUrl: serverUrl,
      onAccountServerRequestIssued: () => { createRequestStarted = true; },
    });
    const context = {
      surface: 'cli' as const,
      actionCaller: { kind: 'host' as const },
      serverId,
      ...(command === 'create'
        ? { presentUserConfirmation: { actionId: 'account.apiTokens.create' as const } }
        : command === 'revoke'
          ? { presentUserConfirmation: { actionId: 'account.apiTokens.revoke' as const } }
          : command === 'revoke-all'
            ? { presentUserConfirmation: { actionId: 'account.apiTokens.revokeAll' as const } }
            : {}),
      ...(signal ? { signal } : {}),
    };
    let data: unknown;
    if (command === 'create') {
      const tokenId = randomUUID();
      const expiresAt = readFlagValue(args, '--expires-at');
      const parsed = AccountApiTokensCreateActionInputV1Schema.safeParse({
        tokenId,
        label: readFlagValue(args, '--label'),
        ...(expiresAt ? { expiresAt } : {}),
        ...(args.includes('--authorize-unattended-team-access') ? { authorizeUnattendedTeamAccess: true } : {}),
      });
      if (!parsed.success) throw new ApiTokenCommandError('invalid_arguments', USAGE);
      requestedTokenId = tokenId;
      const prepared = args.includes('--encryption')
        ? await runWithServerHttpBaseUrl(
            serverUrl,
            () => prepareEncryption(credentials, serverUrl, tokenId, signal),
          )
        : null;
      try {
        if (signal?.aborted) throw new ApiTokenCommandError('cancelled');
        const result = await executor.execute('account.apiTokens.create', {
          ...parsed.data,
          tokenId,
          ...(prepared ? { encryption: { access: prepared.encryptionAccess } } : {}),
        }, context);
        const created = AccountApiTokensCreateActionOutputV1Schema.parse(unwrap(result));
        if (
          created.apiToken.tokenId !== tokenId
          || parseAccountApiTokenBearerV1(created.token)?.tokenId !== tokenId
        ) {
          throw new ApiTokenCommandError('api_token_response_mismatch');
        }
        if (prepared) {
          data = { ...created, token: formatAccountApiTokenCredentialV1({
            bearer: created.token, wrappingSecret: encodeBase64(prepared.wrappingSecret, 'base64url'),
            serverIdentityId: prepared.context.serverIdentityId, accountId: prepared.context.accountId,
            contentPublicKey: prepared.context.contentPublicKey,
          }) };
        } else data = created;
        signal?.throwIfAborted();
      } catch (error) {
        // Known Action settlements are pre-effect or otherwise explicit. Only
        // canonical transport uncertainty or a mismatched post-effect success
        // acknowledgement makes creation unknowable to this process.
        outcomeUnknown = createRequestStarted && (!(error instanceof ApiTokenCommandError)
          || error.code === 'outcome_unknown'
          || error.code === 'api_token_response_mismatch');
        throw error;
      } finally { prepared?.wrappingSecret.fill(0); }
    } else if (command === 'list') {
      data = AccountApiTokensListActionOutputV1Schema.parse(unwrap(await executor.execute('account.apiTokens.list', {}, context)));
    } else if (command === 'revoke') {
      const input = AccountApiTokensRevokeActionInputV1Schema.safeParse({ tokenId: readCommandPositionals(args, { startIndex: 1 })[0] });
      if (!input.success) throw new ApiTokenCommandError('invalid_arguments', USAGE);
      data = unwrap(await executor.execute('account.apiTokens.revoke', input.data, context));
    } else data = unwrap(await executor.execute('account.apiTokens.revokeAll', {}, context));
    if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind, data });
    else if (command === 'list') printTokenList(AccountApiTokensListActionOutputV1Schema.parse(data).tokens);
    else await writeJsonStdout(data, { pretty: true });
  } catch (error) {
    const code = outcomeUnknown ? 'api_token_creation_outcome_unknown' : error instanceof ApiTokenCommandError ? error.code : isAuthenticationError(error) ? 'not_authenticated' : 'api_token_operation_failed';
    const recoveryTokenId = requestedTokenId && (outcomeUnknown || code === 'api_token_response_mismatch')
      ? requestedTokenId
      : undefined;
    const message = outcomeUnknown ? requestedTokenId
      ? 'Creation may have committed. List tokens and revoke the requested token before deliberately creating a replacement.'
      : 'Creation may have committed. The one-time secret cannot be recovered. Review the token list before deliberately creating a replacement.'
      : error instanceof ApiTokenCommandError ? error.message : 'The API-token operation failed.';
    const failure = { code, message, ...(recoveryTokenId ? { tokenId: recoveryTokenId } : {}) };
    if (wantsJson(args)) await printJsonEnvelope({ ok: false, kind, error: failure });
    else { console.error(`${message}${recoveryTokenId ? ` Requested token: ${recoveryTokenId}` : ''}`); process.exitCode = 1; }
  }
}
