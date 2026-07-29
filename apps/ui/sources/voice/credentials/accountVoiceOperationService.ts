import {
  classifyVoiceProviderHttpFailure,
  containsProviderRegisteredSensitiveValue,
  createRecipientContractDigestV1,
  materializeRecipientOperationRequestV1,
  normalizeRecipientContractV1,
  type RecipientContractV1,
} from '@happier-dev/protocol';
import type { PluginVoiceAccountOperationService } from '@happier-dev/plugin-sdk/runtime';

import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { readBoundedResponseBody } from '@/utils/system/readBoundedResponseBody';

import {
  materializeAccountVoiceCredential,
  resolveAccountVoiceCredential,
} from './accountVoiceCredential';

export type AccountVoiceRecipientContractBinding = RecipientContractV1;

export type VoiceAccountOperationAttemptService =
  PluginVoiceAccountOperationService
  & Readonly<{
    /**
     * Passive, attempt-scoped authority inspection. It performs no provider
     * request and never materializes the selected secret.
     */
    inspectAvailability(): Promise<void>;
  }>;

function operationError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function hasHeader(headers: Readonly<Record<string, string>> | undefined, name: string): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers ?? {}).some((candidate) => candidate.toLowerCase() === normalized);
}

type AccountCredentialAuthority = Readonly<{
  settingsScope: ReturnType<typeof storage.getState>['settingsScope'];
  providerEnvelope: unknown;
  binding: ReturnType<typeof storage.getState>['settings']['voice']['credentialBindings'][number] | null;
  secret: ReturnType<typeof storage.getState>['settings']['secrets'][number] | null;
}>;

function captureAccountCredentialAuthority(
  providerId: string,
  credentialSlotId: string,
): AccountCredentialAuthority {
  const state = storage.getState();
  const reference = resolveAccountVoiceCredential(state.settings, providerId, credentialSlotId);
  const providerEnvelope = (state.settings.voice as Readonly<{
    providers?: Readonly<Record<string, unknown>>;
  }>).providers?.[providerId] ?? null;
  return {
    settingsScope: state.settingsScope,
    providerEnvelope,
    binding: state.settings.voice.credentialBindings.find(
      (candidate) => candidate.providerId === providerId,
    ) ?? null,
    secret: reference
      ? state.settings.secrets.find((candidate) => candidate.id === reference.secretId) ?? null
      : null,
  };
}

function isSameAccountCredentialAuthority(
  left: AccountCredentialAuthority,
  right: AccountCredentialAuthority,
): boolean {
  return left.settingsScope === right.settingsScope
    && left.providerEnvelope === right.providerEnvelope
    && left.binding === right.binding
    && left.secret === right.secret;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  try {
    return await readBoundedResponseBody({
      response,
      maxBytes,
      signal,
    });
  } catch {
    if (signal.aborted) {
      throw operationError('voice_account_operation_cancelled');
    }
    throw operationError('provider_response_invalid');
  }
}

function composeAccountOperationSignal(
  authoritySignal: AbortSignal,
  requestSignal: AbortSignal,
): Readonly<{ signal: AbortSignal; dispose(): void }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (authoritySignal.aborted || requestSignal.aborted) abort();
  authoritySignal.addEventListener('abort', abort, { once: true });
  requestSignal.addEventListener('abort', abort, { once: true });
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      authoritySignal.removeEventListener('abort', abort);
      requestSignal.removeEventListener('abort', abort);
    },
  });
}

function projectJsonBody(body: Uint8Array, sourceCredential: string, maxBytes: number): Uint8Array {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    const projectedText = JSON.stringify(JSON.parse(text));
    if (
      projectedText === undefined
      || containsProviderRegisteredSensitiveValue(projectedText, [sourceCredential])
    ) {
      throw operationError('provider_response_invalid');
    }
    const projected = new TextEncoder().encode(projectedText);
    if (projected.byteLength > maxBytes) {
      throw operationError('provider_response_invalid');
    }
    return projected;
  } catch (error) {
    if ((error as Readonly<{ code?: unknown }>).code === 'provider_response_invalid') throw error;
    throw operationError('provider_response_invalid');
  }
}

/**
 * Trusted first-party UI binding for the public Voice account-operation
 * contract. The account SavedSecret is materialized only after the declared
 * request has been validated and only for the duration of the exact fetch.
 */
export function createAccountVoiceOperationService(input: Readonly<{
  providerId: string;
  recipientContract: AccountVoiceRecipientContractBinding;
  signal: AbortSignal;
  isCurrent: () => boolean;
  fetch?: typeof globalThis.fetch;
  materializeSecret?: () => Promise<string | null> | string | null;
  requireRecipientApproval?: boolean;
}>): VoiceAccountOperationAttemptService {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const recipientContract = normalizeRecipientContractV1(input.recipientContract);
  const recipientContractDigest = createRecipientContractDigestV1(recipientContract);
  const credentialSlotId = recipientContract.credentialSlot.id;
  const accountAuthority = captureAccountCredentialAuthority(
    input.providerId,
    credentialSlotId,
  );
  const isAuthorityCurrent = (): boolean => input.isCurrent()
    && isSameAccountCredentialAuthority(
      accountAuthority,
      captureAccountCredentialAuthority(input.providerId, credentialSlotId),
    );
  const inspectAvailability = async (): Promise<void> => {
    if (input.signal.aborted || !isAuthorityCurrent()) {
      throw operationError('voice_account_operation_cancelled');
    }
    if (
      input.requireRecipientApproval
      && accountAuthority.binding?.approvedRecipientContractDigest !== recipientContractDigest
    ) {
      throw operationError('credential_access_review_required');
    }
    if (!accountAuthority.secret) {
      throw operationError('credential_unavailable');
    }
  };
  return Object.freeze({
    inspectAvailability,
    async request(request) {
      const operationSignal = composeAccountOperationSignal(input.signal, request.signal);
      try {
        if (operationSignal.signal.aborted || !isAuthorityCurrent()) {
          throw operationError('voice_account_operation_cancelled');
        }
        let materialized: ReturnType<typeof materializeRecipientOperationRequestV1>;
        try {
          materialized = materializeRecipientOperationRequestV1({
            contract: recipientContract,
            operationId: request.operationId,
            parameters: request.parameters,
          });
        } catch {
          throw operationError('voice_account_operation_unauthorized');
        }
        const operation = materialized.operation;
        let finalUrl: URL;
        try {
          finalUrl = new URL(materialized.url);
        } catch {
          throw operationError('voice_account_operation_unauthorized');
        }
        if (
          finalUrl.origin !== operation.request.origin
          || finalUrl.protocol !== 'https:'
          || finalUrl.username
          || finalUrl.password
          || hasHeader(materialized.headers, operation.request.credential.name)
        ) {
          throw operationError('voice_account_operation_unauthorized');
        }
        await inspectAvailability();
        const materializeSecret = input.materializeSecret ?? (() => materializeAccountVoiceCredential({
          settings: storage.getState().settings,
          providerId: input.providerId,
          credentialSlotId,
          ...(input.requireRecipientApproval
            ? { requiredRecipientContractDigest: recipientContractDigest }
            : {}),
          decrypt: (value) => sync.decryptSecretValue(value),
        }));
        const sourceCredential = await materializeSecret();
        if (!sourceCredential) throw operationError('credential_unavailable');
        if (operationSignal.signal.aborted || !isAuthorityCurrent()) {
          throw operationError('voice_account_operation_cancelled');
        }
        const credentialValue = operation.request.credential.format === 'bearer'
          ? `Bearer ${sourceCredential}`
          : sourceCredential;
        const requestBody = materialized.body ? Uint8Array.from(materialized.body).buffer : null;
        const response = await fetchImpl(materialized.url, {
          method: materialized.method,
          headers: {
            ...materialized.headers,
            [operation.request.credential.name]: credentialValue,
          },
          ...(requestBody ? { body: requestBody } : {}),
          redirect: 'error',
          signal: operationSignal.signal,
        });
        if (operationSignal.signal.aborted || !isAuthorityCurrent()) {
          await response.body?.cancel().catch(() => undefined);
          throw operationError('voice_account_operation_cancelled');
        }
        const responseContentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
        if (response.redirected) {
          await response.body?.cancel().catch(() => undefined);
          throw operationError('provider_response_invalid');
        }
        const httpFailure = classifyVoiceProviderHttpFailure(response.status);
        if (httpFailure) {
          await response.body?.cancel().catch(() => undefined);
          throw operationError(httpFailure);
        }
        if (!operation.response.contentTypes.includes(responseContentType)) {
          await response.body?.cancel().catch(() => undefined);
          throw operationError('provider_response_invalid');
        }
        const responseBody = await readBoundedBody(
          response,
          operation.response.maxBytes,
          operationSignal.signal,
        );
        if (operationSignal.signal.aborted || !isAuthorityCurrent()) {
          throw operationError('voice_account_operation_cancelled');
        }
        const body = projectJsonBody(responseBody, sourceCredential, operation.response.maxBytes);
        return Object.freeze({
          status: response.status,
          finalUrl: materialized.url,
          headers: Object.freeze({ 'content-type': responseContentType }),
          body,
        });
      } catch (error) {
        if (operationSignal.signal.aborted || !isAuthorityCurrent()) {
          throw operationError('voice_account_operation_cancelled');
        }
        throw error;
      } finally {
        operationSignal.dispose();
      }
    },
  });
}
