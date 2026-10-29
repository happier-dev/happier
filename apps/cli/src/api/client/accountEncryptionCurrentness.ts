import axios from '@/api/client/credentialAxios';
import { CredentialRequestRedirectError } from '@happier-dev/cli-common/homeTarget';
import { AccountEncryptionCurrentnessResponseSchema, AccountEncryptionCurrentnessErrorResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import type { AccountEncryptionCurrentnessResponse, AccountEncryptionCurrentnessErrorResponse } from '@happier-dev/protocol/account/encryptionMode';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readStoredCredentials } from '@/persistence';
import { resolveConnectedServicesServerApiTimeoutMs } from './connectedServicesServerApiTimeout';
import { createHttpStatusError } from './httpStatusError';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';
import { classifyServerEndpointError } from './classifyServerEndpointError';

export class AccountEncryptionCurrentnessUnavailableError extends Error {
  readonly code = 'account_encryption_currentness_unavailable' as const;

  constructor(
    message = 'Account encryption currentness is unavailable',
    readonly recipientEnvelopeReadiness?: AccountEncryptionCurrentnessErrorResponse['recipientEnvelopeReadiness'],
    options?: ErrorOptions,
  ) {
    // Keep the observation phase and original transport cause together.
    // A failed read does not establish that the Home is offline.
    super(message, options);
    this.name = 'AccountEncryptionCurrentnessUnavailableError';
  }
}

/** A failed Home observation does not establish missing or mismatched Account material. */
export function isRetryableAccountEncryptionCurrentnessError(error: unknown): boolean {
  return error instanceof AccountEncryptionCurrentnessUnavailableError
    && classifyServerEndpointError(error).retryable;
}

type AccountEncryptionCurrentnessRead = Readonly<{
  token: string;
  authorizationHeaders?: Readonly<Record<string, string>>;
  /** Provisioning checks readiness without binding retained historical material. */
  allowCredentialRecovery?: boolean;
  request?: () => Promise<Readonly<{ status: number; data: unknown }>>;
  serverBaseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export async function fetchAccountEncryptionCurrentness(params: AccountEncryptionCurrentnessRead): Promise<AccountEncryptionCurrentnessResponse> {
  // Exact witnesses include the Account-wide cursor. Identity observations
  // cannot supply it: a claim advances that cursor before its socket wake.
  return await fetchAccountEncryptionCurrentnessFromServer(params);
}

/** The observation's initial/unknown/reconnect read; never consult its own pending fact. */
export async function fetchAccountEncryptionCurrentnessFromServer(params: AccountEncryptionCurrentnessRead): Promise<AccountEncryptionCurrentnessResponse> {
  const serverBaseUrl = (params.serverBaseUrl ?? resolveServerHttpBaseUrl())
    .replace(/\/+$/, '');
  const readCurrentness = params.request ?? (async () => await axios.get(
    `${serverBaseUrl}/v1/account/encryption/currentness`,
    {
      headers: params.authorizationHeaders ?? {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${params.token}`,
      },
      timeout: params.timeoutMs ?? resolveConnectedServicesServerApiTimeoutMs(),
      validateStatus: () => true,
      ...(params.signal ? { signal: params.signal } : {}),
    },
  ));
  let response;
  try {
    response = await readCurrentness();
  } catch (error) {
    if (error instanceof CredentialRequestRedirectError) throw error;
    if (params.signal?.aborted) throw error;
    throw new AccountEncryptionCurrentnessUnavailableError(undefined, undefined, { cause: error });
  }
  const legacyReadiness = response.status === 400
    ? AccountEncryptionCurrentnessErrorResponseSchema.safeParse(response.data)
    : null;
  const suppliedAuthorization = params.authorizationHeaders
    ? Object.entries(params.authorizationHeaders).find(([key]) => key.toLowerCase() === 'authorization')?.[1]
    : null;
  if (
    params.allowCredentialRecovery !== false
    && legacyReadiness?.success
    && legacyReadiness.data.recipientEnvelopeReadiness.reason === 'encryption_setup_required'
    && (!params.authorizationHeaders || suppliedAuthorization === `Bearer ${params.token}`)
  ) {
    const stored = await readStoredCredentials().catch(() => null);
    const expectedAccountId = readAccountIdFromToken(params.token);
    if (
      stored?.token === params.token
      && stored.credentialProvenance === 'stored_session'
      && stored.encryption?.type === 'legacy'
      && expectedAccountId
    ) {
      try {
        const snapshot = await fetchServerFeaturesSnapshot({
          serverUrl: serverBaseUrl,
          token: params.token,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        const serverIdentityId = snapshot.status === 'ready'
          ? snapshot.features.capabilities.serverIdentity.serverIdentityId?.trim()
          : null;
        if (serverIdentityId) {
          const { authenticateExistingAccountWithLegacySecret } = await import('@/cli/commands/auth/nativeEmail');
          // The Home's expectedAccountId branch requires an already-bound key;
          // this existing-Account proof repairs the missing binding, then we
          // compare its issued Account with the stored bearer's subject.
          const repairedToken = await authenticateExistingAccountWithLegacySecret({
            secret: stored.encryption.secret,
            serverApiUrl: serverBaseUrl,
            serverIdentityId,
            ...(params.signal ? { signal: params.signal } : {}),
          });
          if (readAccountIdFromToken(repairedToken) !== expectedAccountId) {
            throw new Error('Recovered Account does not match the stored bearer');
          }
          response = await readCurrentness();
        }
      } catch (error) {
        if (error instanceof CredentialRequestRedirectError) throw error;
        params.signal?.throwIfAborted();
        // Preserve the original typed recovery result when proof cannot be completed.
      }
    }
  }
  if (response.status !== 200) {
    const parsedError = response.status === 400
      ? AccountEncryptionCurrentnessErrorResponseSchema.safeParse(response.data)
      : null;
    const message = `Account encryption currentness is unavailable (${response.status})`;
    throw new AccountEncryptionCurrentnessUnavailableError(
      message,
      parsedError?.success ? parsedError.data.recipientEnvelopeReadiness : undefined,
      // `validateStatus` suppresses Axios' own rejection, so carry the status
      // on the canonical minimal Axios-like error the status policies read.
      { cause: createHttpStatusError(response.status, message) },
    );
  }
  const parsed = AccountEncryptionCurrentnessResponseSchema.safeParse(
    response.data,
  );
  if (!parsed.success) {
    throw new AccountEncryptionCurrentnessUnavailableError(
      'Account encryption currentness response is invalid',
    );
  }
  return parsed.data;
}
