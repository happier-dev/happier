import {
  buildConnectedServiceCredentialRecord,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';
import type {
  CloudAuthDiagnosticV1,
  CloudConnectAuthenticateOptionsV1,
  CloudConnectAuthenticateResultV1,
  CloudCustomAuthenticatorContextV1,
  FetchRuntimeHeadersV1,
  FetchRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

import { resolveCodexCloudAuthMode } from './authenticator.js';
import {
  authenticateCodexDevice,
  OPENAI_CODEX_DEVICE_VERIFICATION_URL,
} from './device.js';
import {
  buildCodexAuthorizationUrl,
  exchangeCodexAuthorizationCodeForTokens,
} from './exchange.js';
import type { CodexAuthTokens } from './types.js';

const CODEX_CLOUD_SERVICE_ID = 'openai-codex';
const DEFAULT_PROFILE_ID = 'default';
const DEFAULT_CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';

function resolveTimeoutMs(opts: CloudConnectAuthenticateOptionsV1): number | undefined {
  return typeof opts.timeoutSeconds === 'number' && Number.isFinite(opts.timeoutSeconds)
    ? Math.max(1, Math.trunc(opts.timeoutSeconds)) * 1000
    : undefined;
}

function failure(
  code: Exclude<CloudConnectAuthenticateResultV1, { ok: true }>['code'],
  diagnostic: CloudAuthDiagnosticV1,
): Extract<CloudConnectAuthenticateResultV1, { ok: false }> {
  return {
    ok: false,
    code,
    diagnostics: [diagnostic],
  };
}

function providerFailure(error: unknown): Extract<CloudConnectAuthenticateResultV1, { ok: false }> {
  return failure('provider_error', {
    code: 'codex_cloud_provider_error',
    message: error instanceof Error ? error.message : String(error),
  });
}

function resolveCredentialTarget(
  opts: CloudConnectAuthenticateOptionsV1,
): Readonly<{ serviceId: typeof CODEX_CLOUD_SERVICE_ID; profileId: string }> | Extract<CloudConnectAuthenticateResultV1, { ok: false }> {
  const requestedServiceId = opts.serviceId ?? CODEX_CLOUD_SERVICE_ID;
  if (requestedServiceId !== CODEX_CLOUD_SERVICE_ID) {
    return failure('unsupported', {
      code: 'codex_cloud_service_unsupported',
      message: 'Codex cloud OAuth credentials can only be written to the openai-codex connected service.',
    });
  }
  return {
    serviceId: CODEX_CLOUD_SERVICE_ID,
    profileId: opts.profileId?.trim() || DEFAULT_PROFILE_ID,
  };
}

function buildCredentialRecord(params: Readonly<{
  tokens: Readonly<{
    accessToken: string;
    refreshToken: string;
    idToken: string | null;
    accountId: string;
    expiresAt: number | null;
  }>;
  now: number;
  profileId: string;
}>): ConnectedServiceCredentialRecordV1 {
  return buildConnectedServiceCredentialRecord({
    now: params.now,
    serviceId: CODEX_CLOUD_SERVICE_ID,
    profileId: params.profileId,
    kind: 'oauth',
    expiresAt: params.tokens.expiresAt,
    oauth: {
      accessToken: params.tokens.accessToken,
      refreshToken: params.tokens.refreshToken,
      idToken: params.tokens.idToken,
      scope: 'openid profile email offline_access',
      tokenType: 'Bearer',
      providerAccountId: params.tokens.accountId,
      providerEmail: null,
    },
  });
}

async function writeCredential(params: Readonly<{
  opts: CloudConnectAuthenticateOptionsV1;
  context: CloudCustomAuthenticatorContextV1;
  tokens: Readonly<{
    accessToken: string;
    refreshToken: string;
    idToken: string | null;
    accountId: string;
    expiresAt: number | null;
  }>;
}>): Promise<CloudConnectAuthenticateResultV1> {
  const target = resolveCredentialTarget(params.opts);
  if ('ok' in target) return target;

  const record = buildCredentialRecord({
    tokens: params.tokens,
    now: params.context.now(),
    profileId: target.profileId,
  });
  const written = await params.context.credentials.write({
    serviceId: target.serviceId,
    profileId: target.profileId,
    record,
  });
  if (!written.ok) {
    return {
      ok: false,
      code: written.code,
      diagnostics: written.diagnostics,
    };
  }
  return {
    ok: true,
    accountRef: params.tokens.accountId,
    credentialRef: written.credentialRef,
  };
}

function normalizeFetchHeaders(headers: HeadersInit | undefined): FetchRuntimeHeadersV1 | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    const normalized: Record<string, string> = {};
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers;
}

function createFetchAdapter(runtimeFetch: FetchRuntimeServiceV1, signal: AbortSignal): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await runtimeFetch({
      url: String(url),
      method: init?.method,
      headers: normalizeFetchHeaders(init?.headers),
      body: init?.body,
      signal,
    });
    return response as unknown as Response;
  }) as typeof fetch;
}

async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('connect_oauth_cancelled');
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      reject(new Error('connect_oauth_cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function authenticateDevice(
  opts: CloudConnectAuthenticateOptionsV1,
  context: CloudCustomAuthenticatorContextV1,
): Promise<CloudConnectAuthenticateResultV1> {
  const timeoutMs = resolveTimeoutMs(opts);
  const deadline = timeoutMs ? context.now() + timeoutMs : null;
  try {
    const tokens = await authenticateCodexDevice({
      fetcher: createFetchAdapter(context.fetch, context.signal),
      now: context.now(),
      onUserCode: ({ verificationUrl, userCode }) => {
        if (!opts.noOpen) {
          void context.browser.open(verificationUrl);
        }
        void context.prompt.requestText({
          label: `Open this URL in a browser to authenticate:\n\n${verificationUrl}\n\nEnter this code:\n\n${userCode}\n\nPress Enter after approving the request: `,
        });
      },
      sleep: async (ms) => {
        if (deadline && context.now() + ms > deadline) {
          throw new Error('connect_oauth_timeout');
        }
        await sleepWithSignal(ms, context.signal);
      },
    });
    return await writeCredential({
      opts,
      context,
      tokens: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        accountId: tokens.account_id,
        expiresAt: tokens.expires_at ?? null,
      },
    });
  } catch (error) {
    return providerFailure(error);
  }
}

async function authenticatePkce(
  mode: 'loopback' | 'paste',
  opts: CloudConnectAuthenticateOptionsV1,
  context: CloudCustomAuthenticatorContextV1,
): Promise<CloudConnectAuthenticateResultV1> {
  const effectiveMode = opts.noOpen ? 'paste' : mode;
  const timeoutMs = resolveTimeoutMs(opts);
  const pkce = await context.oauth.createPkceChallenge();
  const created = await context.oauth.callback.create({
    mode: effectiveMode,
    preferredPort: DEFAULT_CALLBACK_PORT,
    callbackPath: CALLBACK_PATH,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  if (!created.ok) return created;

  const authorizationUrl = buildCodexAuthorizationUrl({
    redirectUri: created.session.redirectUri,
    state: created.session.state,
    challenge: pkce.challenge,
  });

  try {
    if (effectiveMode === 'loopback') {
      const opened = await context.browser.open(authorizationUrl);
      if (!opened.ok) return opened;
    }

    const callback = await created.session.wait({
      promptLabel: `Open this URL in a browser to authenticate:\n\n${authorizationUrl}\n\nAfter login, paste the final redirected URL: `,
    });
    if (!callback.ok) return callback;

    const tokens = await exchangeCodexAuthorizationCodeForTokens({
      code: callback.code,
      verifier: pkce.verifier,
      redirectUri: callback.redirectUri,
      now: context.now(),
      runtimeFetch: context.fetch,
    });
    return await writeCredential({ opts, context, tokens });
  } catch (error) {
    return providerFailure(error);
  } finally {
    await created.session.close();
  }
}

export async function authenticateCodexCloudConnect(
  opts: CloudConnectAuthenticateOptionsV1,
  context: CloudCustomAuthenticatorContextV1,
): Promise<CloudConnectAuthenticateResultV1> {
  const mode = resolveCodexCloudAuthMode(opts);
  return mode === 'device'
    ? await authenticateDevice(opts, context)
    : await authenticatePkce(mode, opts, context);
}
