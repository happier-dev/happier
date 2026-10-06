import { randomBytes as nodeRandomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { ExternalOAuthFinalizeAuthSuccessResponseSchema, ExternalOAuthParamsResponseSchema } from '@happier-dev/protocol/auth/externalOAuth';
import { KeyChallengeV2IssueResponseSchema, canonicalizeKeyChallengeV2AudienceOrigin, createKeyChallengeV2SigningInput } from '@happier-dev/protocol/auth/keyChallenge';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { parseRecoveryKey } from '@happier-dev/protocol/auth/recoveryKey';

import { captureLoopbackOauthRedirect } from '@/cloud/loopbackOauthPkce';
import { describeBrowserHandoffFallback, openBrowser } from '@/ui/openBrowser';
import { createExternalAuthProof } from '@/auth/externalAuthProof';
import type { CliAccountServiceSelection } from './cliAccountServiceSession';

type RequestedMethod = Readonly<{
  kind: 'key';
  action?: 'login' | 'provision';
  mode?: 'keyed';
}> | Readonly<{
  kind: 'provider';
  providerId: string;
  action: 'login' | 'provision';
  mode: 'keyed' | 'keyless';
}>;

export type CliAccountServiceAuthOutcome =
  | Readonly<{
      kind: 'authenticated';
      credential: Readonly<{ token: string }>;
      recoveryKey?: Uint8Array;
    }>
  | Readonly<{ kind: 'key_required' | 'update_required' | 'account_service_unavailable' | 'cancelled' | 'timed_out' | 'identity_mismatch' | 'destination_mismatch' | 'failed' }>;

type CallbackBinding = Readonly<{
  pending: string;
  purpose: string;
  credentialTarget: string;
  endpointUrl: string;
  endpointServerIdentityId: string;
  canonicalServerUrl: string;
}>;

type AuthDependencies = Readonly<{
  request?: (path: string, init?: RequestInit) => Promise<Response>;
  randomBytes?: (size: number) => Uint8Array;
  /**
   * Terminal writer for the headless browser handoff. The composing coordinator
   * injects one that yields its progress animation before writing.
   */
  write?: (line: string) => void;
  runBrowserCallback?: (input: Readonly<{
    providerId: string;
    expected: Omit<CallbackBinding, 'pending'>;
    signal?: AbortSignal;
    resolveAuthorizationUrl(callbackOrigin: string): Promise<string>;
  }>) => Promise<CallbackBinding>;
}>;

function normalizeEndpoint(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
    return parsed.toString().replace(/\/$/u, '');
  } catch {
    return null;
  }
}

function defaultRequest(endpoint: string): NonNullable<AuthDependencies['request']> {
  return async (path, init) => await fetch(`${endpoint}${path}`, init);
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Sign-in request failed (${response.status})`);
  return await response.json();
}

function expectedBinding(service: CliAccountServiceSelection): Omit<CallbackBinding, 'pending'> {
  return {
    purpose: 'account_directory',
    credentialTarget: 'account_directory',
    endpointUrl: service.endpoint,
    endpointServerIdentityId: service.serverIdentityId,
    canonicalServerUrl: service.canonicalServerUrl,
  };
}

function mapError(error: unknown): CliAccountServiceAuthOutcome {
  if (error instanceof Error && error.name === 'AbortError') return { kind: 'cancelled' };
  if (error instanceof Error && /timeout/iu.test(error.message)) return { kind: 'timed_out' };
  return { kind: 'account_service_unavailable' };
}

export function parseCliAccountServiceRecoveryKey(input: string): Uint8Array | null {
  const parsed = parseRecoveryKey(input);
  return parsed.ok ? parsed.bytes : null;
}

export async function authenticateCliAccountService(
  input: Readonly<{
    service: CliAccountServiceSelection;
    method: RequestedMethod;
    key?: Uint8Array;
    signal?: AbortSignal;
    timeoutMs?: number;
  }>,
  deps: AuthDependencies = {},
): Promise<CliAccountServiceAuthOutcome> {
  const endpoint = normalizeEndpoint(input.service.endpoint);
  const canonicalOrigin = canonicalizeKeyChallengeV2AudienceOrigin(input.service.canonicalServerUrl);
  if (!endpoint || !canonicalOrigin || canonicalOrigin !== input.service.canonicalServerUrl) return { kind: 'destination_mismatch' };
  if (input.signal?.aborted) return { kind: 'cancelled' };
  const request = deps.request ?? defaultRequest(endpoint);

  try {
    if (input.method.kind === 'key') {
      const generatedKey = input.method.action === 'provision'
        ? (deps.randomBytes ?? ((size: number) => new Uint8Array(nodeRandomBytes(size))))(32)
        : null;
      const key = input.key ?? generatedKey;
      if (!(key instanceof Uint8Array) || key.byteLength !== 32) return { kind: 'key_required' };
      const issue = KeyChallengeV2IssueResponseSchema.safeParse(await readJson(await request(
        '/v1/auth/account-directory/challenge',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' , signal: input.signal },
      )));
      if (!issue.success) return { kind: 'update_required' };
      if (issue.data.audience.origin !== canonicalOrigin
        || issue.data.audience.serverIdentityId !== input.service.serverIdentityId) {
        return { kind: 'identity_mismatch' };
      }
      const keyPair = tweetnacl.sign.keyPair.fromSeed(key);
      const signature = tweetnacl.sign.detached(createKeyChallengeV2SigningInput(issue.data), keyPair.secretKey);
      const authPayload = await readJson(await request('/v1/auth/account-directory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: input.signal,
        body: JSON.stringify({
          challengeId: issue.data.challengeId,
          signature: encodeBase64(signature),
          publicKey: encodeBase64(keyPair.publicKey),
        }),
      }));
      const token = typeof authPayload === 'object' && authPayload !== null && typeof (authPayload as { token?: unknown }).token === 'string'
        ? (authPayload as { token: string }).token.trim()
        : '';
      return token
        ? {
            kind: 'authenticated',
            credential: { token },
            ...(generatedKey ? { recoveryKey: generatedKey } : {}),
          }
        : { kind: 'failed' };
    }

    const providerId = input.method.providerId.trim().toLowerCase();
    if (!providerId || !input.service.advertisedMethods.oauthProviderIds.includes(providerId)) return { kind: 'update_required' };
    const admittedOAuthMode = input.method.mode;
    const randomBytes = deps.randomBytes ?? ((size: number) => new Uint8Array(nodeRandomBytes(size)));
    const recoveryKey = admittedOAuthMode === 'keyed' ? randomBytes(32) : null;
    const keylessProof = admittedOAuthMode === 'keyless'
      ? createExternalAuthProof(randomBytes)
      : null;
    const proof = keylessProof?.proof ?? null;
    const proofHash = keylessProof?.proofHash ?? null;
    const publicKey = recoveryKey
      ? encodeBase64(tweetnacl.sign.keyPair.fromSeed(recoveryKey).publicKey)
      : null;
    const expected = expectedBinding(input.service);
    const resolveAuthorizationUrl = async (callbackOrigin: string): Promise<string> => {
      const query = new URLSearchParams({
        mode: admittedOAuthMode,
        ...(proofHash ? { proofHash } : {}),
        ...(publicKey ? { publicKey } : {}),
        purpose: 'account_directory',
        endpointUrl: expected.endpointUrl,
        endpointServerIdentityId: expected.endpointServerIdentityId,
        canonicalServerUrl: expected.canonicalServerUrl,
      });
      const parsed = ExternalOAuthParamsResponseSchema.safeParse(await readJson(await request(
        `/v1/auth/external/${encodeURIComponent(providerId)}/params?${query}`,
        { method: 'GET', headers: { Origin: callbackOrigin }, signal: input.signal },
      )));
      if (!parsed.success || !('purpose' in parsed.data)) {
        throw new Error('Sign-in with this service is unsupported');
      }
      if (parsed.data.purpose !== expected.purpose
        || !('credentialTarget' in parsed.data)
        || parsed.data.credentialTarget !== expected.credentialTarget
        || !('endpointUrl' in parsed.data)
        || parsed.data.endpointUrl !== expected.endpointUrl
        || !('endpointServerIdentityId' in parsed.data)
        || parsed.data.endpointServerIdentityId !== expected.endpointServerIdentityId
        || !('canonicalServerUrl' in parsed.data)
        || parsed.data.canonicalServerUrl !== expected.canonicalServerUrl) {
        throw new Error('Sign-in destination mismatch');
      }
      return parsed.data.url;
    };
    const callback = deps.runBrowserCallback
      ? await deps.runBrowserCallback({
          providerId,
          expected,
          ...(input.signal ? { signal: input.signal } : {}),
          resolveAuthorizationUrl,
        })
      : await captureLoopbackOauthRedirect({
          callbackPath: `/oauth/${providerId}`,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
          resolveAuthorizationUrl,
          openAuthorizationUrl: async (url) => {
            // A machine with no browser is the headless case this entry exists
            // for: print the link and keep the loopback listener waiting rather
            // than reporting the reachable sign-in service as unavailable.
            if (await openBrowser(url)) return;
            const write = deps.write ?? ((line: string) => console.log(line));
            for (const line of describeBrowserHandoffFallback(url)) write(line);
          },
        }) as CallbackBinding;
    if (callback.endpointServerIdentityId !== expected.endpointServerIdentityId) return { kind: 'identity_mismatch' };
    if (callback.purpose !== expected.purpose
      || callback.credentialTarget !== expected.credentialTarget
      || callback.endpointUrl !== expected.endpointUrl
      || callback.endpointServerIdentityId !== expected.endpointServerIdentityId
      || callback.canonicalServerUrl !== expected.canonicalServerUrl) {
      return { kind: 'destination_mismatch' };
    }
    const finalizeBody = recoveryKey
      ? (() => {
          const challenge = randomBytes(32);
          const keyPair = tweetnacl.sign.keyPair.fromSeed(recoveryKey);
          return {
            pending: callback.pending,
            publicKey: encodeBase64(keyPair.publicKey),
            challenge: encodeBase64(challenge),
            signature: encodeBase64(tweetnacl.sign.detached(challenge, keyPair.secretKey)),
          };
        })()
      : { pending: callback.pending, proof: proof! };
    const finalizeResponse = await request(
      `/v1/auth/external/${encodeURIComponent(providerId)}/${admittedOAuthMode === 'keyless' ? 'finalize-keyless' : 'finalize'}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(finalizeBody), signal: input.signal },
    );
    if (!finalizeResponse.ok) {
      const failure = await finalizeResponse.json().catch(() => null) as { error?: unknown } | null;
      return typeof failure?.error === 'string' && /key|e2ee/iu.test(failure.error)
        ? { kind: 'key_required' }
        : { kind: 'account_service_unavailable' };
    }
    const finalized = ExternalOAuthFinalizeAuthSuccessResponseSchema.safeParse(await finalizeResponse.json());
    return finalized.success
      ? {
          kind: 'authenticated',
          credential: { token: finalized.data.token },
          ...(recoveryKey ? { recoveryKey } : {}),
        }
      : { kind: 'key_required' };
  } catch (error) {
    return mapError(error);
  }
}
