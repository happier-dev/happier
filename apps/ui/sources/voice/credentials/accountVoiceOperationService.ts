import {
  containsProviderRegisteredSensitiveValue,
  materializeRecipientOperationRequestV1,
  normalizeRecipientContractV1,
  resolveVoiceCredentialOperationAuthorization,
  resolveRequiredRecipientContractApprovalDigestV1,
  type PluginContributionIdentityV1,
  type QualifiedConnectedAccountPurposeBindingTargetV1,
  type QualifiedConnectedAccountPurposeV1,
  type RecipientContractV1,
  type VoiceCredentialAccessPhase,
  type VoiceCredentialOperationAuthorization,
  type VoiceCredentialOperationSelectedSource,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';
import {
  classifyVoiceProviderHttpFailure,
  type VoiceAccountOperationService,
} from '@happier-dev/plugin-sdk/voice';

import { storage } from '@/sync/domains/state/storage';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { sync } from '@/sync/sync';
import {
  BoundedResponseBodyError,
  readBoundedResponseBody,
} from '@/utils/system/readBoundedResponseBody';

import {
  resolveAccountVoiceCredential,
  resolveAccountVoiceCredentialSourceSelection,
} from './accountVoiceCredential';

export type AccountVoiceRecipientContractBinding = RecipientContractV1;

export type VoiceAccountOperationAttemptService =
  VoiceAccountOperationService
  & Readonly<{
    /**
     * Passive, attempt-scoped authority inspection. It performs no provider
     * request and never materializes the selected secret.
     */
    inspectAvailability(): Promise<void>;
  }>;

type AccountVoiceResponseFailureKind =
  | 'redirect'
  | 'http_status'
  | 'content_type'
  | 'body_too_large'
  | 'body_read_failed'
  | 'json_projection_failed';

/**
 * Structural, provider-neutral account of *how* an operation failed.
 *
 * It deliberately carries no projection of the provider's own response text. A
 * provider error body is arbitrary prose: it can legitimately echo user or
 * startup instructions, tool definitions, account/workspace/agent identifiers,
 * and transcript fragments, none of which are byte-identical to a registered
 * credential and none of which a credential scrubber can therefore remove. The
 * Voice privacy contract is that Happier diagnostics carry typed transitions,
 * provider identity, and bounded structural facts only, so the body is never
 * read on a failure path and the failure stays a `kind`/status tuple.
 */
type AccountVoiceResponseFailure = Readonly<{
  kind: AccountVoiceResponseFailureKind;
  status: number;
  statusClass: '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'unknown';
}>;

function responseStatusClass(status: number): AccountVoiceResponseFailure['statusClass'] {
  if (!Number.isInteger(status) || status < 100 || status > 599) return 'unknown';
  return `${Math.floor(status / 100)}xx` as AccountVoiceResponseFailure['statusClass'];
}

function responseFailure(
  response: Response,
  kind: AccountVoiceResponseFailureKind,
): AccountVoiceResponseFailure {
  return Object.freeze({
    kind,
    status: response.status,
    statusClass: responseStatusClass(response.status),
  });
}

function operationError(
  code: string,
  responseFailureDiagnostic?: AccountVoiceResponseFailure,
): Error {
  return Object.assign(new Error(code), {
    code,
    ...(responseFailureDiagnostic ? { responseFailure: responseFailureDiagnostic } : {}),
  });
}

function hasHeader(headers: Readonly<Record<string, string>> | undefined, name: string): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers ?? {}).some((candidate) => candidate.toLowerCase() === normalized);
}

function selectedVoiceCredentialOperationSource(
  selection: ReturnType<typeof resolveAccountVoiceCredentialSourceSelection>['selection'],
): VoiceCredentialOperationSelectedSource | null {
  if (selection.kind === 'savedSecret') return Object.freeze({ kind: 'savedSecret' });
  if (selection.kind !== 'connectedAccount') return null;
  const service = selection.target.kind === 'account'
    ? selection.target.account.service
    : selection.target.service;
  return Object.freeze({ kind: 'connectedAccount', service: Object.freeze({ ...service }) });
}

type AccountCredentialAuthority = Readonly<{
  settingsScope: ReturnType<typeof storage.getState>['settingsScope'];
  providerEnvelope: unknown;
  binding: ReturnType<typeof storage.getState>['settings']['voiceSettingsV1']['credentialBindings'][number] | null;
  secret: ReturnType<typeof storage.getState>['settings']['secrets'][number] | null;
  source: ReturnType<typeof resolveAccountVoiceCredentialSourceSelection>;
}>;

/**
 * Existing machine-error kind, reused verbatim for "the account-settings
 * snapshot could not be read right now".
 *
 * It is deliberately **not** a `VoiceProviderCredentialRemediationCode`: the
 * runtime maps those onto `provider_auth_invalid`, whose recovery action is
 * "Review credentials". Telling a user to review a credential the app never
 * managed to read is a false accusation and offers a remedy that cannot help,
 * so an indeterminate read reports the retryable kind instead.
 */
const CREDENTIAL_SNAPSHOT_INDETERMINATE_CODE = 'service_temporarily_unavailable';

/**
 * Authority read outcome.
 *
 * `captureAccountCredentialAuthority` never reports absence — an absent
 * credential is a *resolved* authority whose selection is `none` or whose
 * SavedSecret is missing. It only throws, and only because the account-settings
 * snapshot could not be read consistently (for example a `connectedAccount`
 * source whose qualified purpose binding is not in that snapshot). Collapsing
 * that throw into `null` made every consumer report `credential_unavailable`,
 * conflating "I could not determine this" with "there is no credential".
 */
type AccountCredentialAuthorityResolution =
  | Readonly<{ state: 'resolved'; authority: AccountCredentialAuthority }>
  | Readonly<{ state: 'indeterminate' }>;

type AccountOperationCredentialAuthority = Readonly<{
  resolution: AccountCredentialAuthorityResolution;
  lease: AccountCredentialAuthorityLease;
}>;

type AccountCredentialAuthorityLease = Readonly<{
  resolution: AccountCredentialAuthorityResolution;
  isCurrent(): boolean;
}>;

function captureAccountCredentialAuthority(
  contribution: PluginContributionIdentityV1,
  providerId: string,
  credentialSlotId: string,
  purpose: QualifiedConnectedAccountPurposeV1,
  machineId: string | null,
): AccountCredentialAuthority {
  const state = storage.getState();
  const reference = resolveAccountVoiceCredential(
    state.settings,
    contribution,
    credentialSlotId,
    machineId,
  );
  const providerEnvelope = (state.settings.voiceSettingsV1 as Readonly<{
    providers?: Readonly<Record<string, unknown>>;
  }> | undefined)?.providers?.[providerId] ?? null;
  const source = resolveAccountVoiceCredentialSourceSelection({
    settings: state.settings,
    contribution,
    credentialSlotId,
    purpose,
    machineId,
  });
  return {
    settingsScope: state.settingsScope,
    providerEnvelope,
    binding: state.settings.voiceSettingsV1.credentialBindings.find(
      (candidate) => candidate.contribution.pluginId === contribution.pluginId
        && candidate.contribution.localId === contribution.localId
        && candidate.credentialSlotId === credentialSlotId,
    ) ?? null,
    secret: reference
      ? state.settings.secrets.find((candidate) => candidate.id === reference.secretId) ?? null
      : null,
    source,
  };
}

function resolveAccountCredentialAuthority(
  contribution: PluginContributionIdentityV1,
  providerId: string,
  credentialSlotId: string,
  purpose: QualifiedConnectedAccountPurposeV1,
  machineId: string | null,
): AccountCredentialAuthorityResolution {
  try {
    return Object.freeze({
      state: 'resolved' as const,
      authority: captureAccountCredentialAuthority(
        contribution,
        providerId,
        credentialSlotId,
        purpose,
        machineId,
      ),
    });
  } catch {
    return Object.freeze({ state: 'indeterminate' as const });
  }
}

function isSameAccountCredentialAuthority(
  left: AccountCredentialAuthority,
  right: AccountCredentialAuthority,
): boolean {
  return (left.settingsScope === right.settingsScope
    || areAccountSettingsScopesEqual(left.settingsScope, right.settingsScope))
    && areAccountSettingsJsonValuesEqual(left.providerEnvelope, right.providerEnvelope)
    && areAccountSettingsJsonValuesEqual(left.binding, right.binding)
    && areAccountSettingsJsonValuesEqual(left.secret, right.secret)
    && areAccountSettingsJsonValuesEqual(left.source, right.source);
}

function createAccountCredentialAuthorityLease(input: Readonly<{
  contribution: PluginContributionIdentityV1;
  providerId: string;
  credentialSlotId: string;
  purpose: QualifiedConnectedAccountPurposeV1;
  machineId: string | null;
  isCurrent(): boolean;
}>): AccountCredentialAuthorityLease {
  // The settings/source comparison identifies the selected credential, but a
  // logout followed by re-entry to the same Account can publish identical
  // settings. Capture the incumbent Account lifetime as the canonical fence
  // for this invocation; no second Account owner or retained watcher is needed.
  const accountScopeLifetime = captureActiveServerAccountScopeLifetime();
  const resolution = resolveAccountCredentialAuthority(
    input.contribution,
    input.providerId,
    input.credentialSlotId,
    input.purpose,
    input.machineId,
  );
  return Object.freeze({
    resolution,
    isCurrent: () => {
      if (
        resolution.state !== 'resolved'
        || !input.isCurrent()
        || (accountScopeLifetime !== null && !accountScopeLifetime.isCurrent())
      ) return false;
      const current = resolveAccountCredentialAuthority(
        input.contribution,
        input.providerId,
        input.credentialSlotId,
        input.purpose,
        input.machineId,
      );
      return current.state === 'resolved'
        && isSameAccountCredentialAuthority(resolution.authority, current.authority);
    },
  });
}

/**
 * Captures the canonical non-secret account credential authority for one host
 * invocation. It shares the exact source/settings comparator used by
 * host-mediated Voice operations, so raw access cannot reselect a changed
 * source halfway through the same provider callback.
 */
export function createAccountVoiceCredentialAuthorityLease(input: Readonly<{
  contribution: PluginContributionIdentityV1;
  providerId: string;
  credentialSlotId: string;
  purpose: QualifiedConnectedAccountPurposeV1;
  machineId?: string | null;
  isCurrent(): boolean;
}>): Readonly<{ isCurrent(): boolean }> {
  const lease = createAccountCredentialAuthorityLease({
    ...input,
    machineId: input.machineId ?? null,
  });
  return Object.freeze({ isCurrent: lease.isCurrent });
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
  } catch (error) {
    if (signal.aborted) {
      throw operationError('voice_account_operation_cancelled');
    }
    throw operationError(
      'provider_response_invalid',
      responseFailure(
        response,
        error instanceof BoundedResponseBodyError && error.code === 'body_too_large'
          ? 'body_too_large'
          : 'body_read_failed',
      ),
    );
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

function projectJsonBody(
  response: Response,
  body: Uint8Array,
  sourceCredentials: readonly string[],
  maxBytes: number,
): Uint8Array {
  const projectionFailure = responseFailure(response, 'json_projection_failed');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    const projectedText = JSON.stringify(JSON.parse(text));
    if (
      projectedText === undefined
      || containsProviderRegisteredSensitiveValue(projectedText, sourceCredentials)
    ) {
      throw operationError('provider_response_invalid', projectionFailure);
    }
    const projected = new TextEncoder().encode(projectedText);
    if (projected.byteLength > maxBytes) {
      throw operationError('provider_response_invalid', projectionFailure);
    }
    return projected;
  } catch (error) {
    if ((error as Readonly<{ code?: unknown }>).code === 'provider_response_invalid') throw error;
    throw operationError('provider_response_invalid', projectionFailure);
  }
}

/**
 * Trusted first-party UI binding for the public Voice account-operation
 * contract. The account SavedSecret is materialized only after the declared
 * request has been validated and only for the duration of the exact fetch.
 */
export function createAccountVoiceOperationService(input: Readonly<{
  providerId: string;
  contribution: PluginContributionIdentityV1;
  declaration: Extract<VoiceProviderContribution, Readonly<{ kind: 'conversation' }>>;
  /** Host-owned lifecycle phase bound by external Voice activation. */
  phase: Exclude<VoiceCredentialAccessPhase, 'speech'>;
  recipientContract: AccountVoiceRecipientContractBinding;
  signal: AbortSignal;
  isCurrent: () => boolean;
  fetch?: typeof globalThis.fetch;
  materializeSecret?: () => Promise<string | null> | string | null;
  /**
   * The selection is passed rather than re-read: the daemon resolves its own
   * current Connected Account independently, so the materializer must name the
   * exact selection this operation's captured authority was resolved under.
   */
  materializeConnectedAccountHeaders?: (input: Readonly<{
    operationId: string;
    selection: QualifiedConnectedAccountPurposeBindingTargetV1;
    signal: AbortSignal;
  }>) => Promise<Readonly<Record<string, string>>>;
}>): VoiceAccountOperationAttemptService {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const recipientContract = normalizeRecipientContractV1(input.recipientContract);
  // `null` for a first-party bundled recipient: a release that changes its
  // mediated operations must not revoke an approval Happier itself authored.
  const requiredRecipientContractDigest =
    resolveRequiredRecipientContractApprovalDigestV1(recipientContract);
  const credentialSlotId = recipientContract.credentialSlot.id;
  const credentialBindingPurpose = Object.freeze({
    consumer: input.contribution,
    purpose: input.declaration.credentials!.slot.purpose,
  });
  const operationAuthorities = new Map<string, AccountOperationCredentialAuthority>(
    recipientContract.operations.map((operation) => [
      operation.id,
      (() => {
        const lease = createAccountCredentialAuthorityLease({
          contribution: input.contribution,
          providerId: input.providerId,
          credentialSlotId,
          // Source selection belongs to the credential slot. The operation's
          // distinct purpose is consumed only by the recipient materializer.
          purpose: credentialBindingPurpose,
          machineId: null,
          isCurrent: input.isCurrent,
        });
        return Object.freeze({
          resolution: lease.resolution,
          lease,
        });
      })(),
    ]),
  );
  const isAuthorityCurrent = (
    operationAuthority: AccountOperationCredentialAuthority,
  ): boolean => operationAuthority.lease.isCurrent();
  const inspectOperationAvailability = async (
    operationId: string,
    operationAuthority: AccountOperationCredentialAuthority,
  ): Promise<VoiceCredentialOperationAuthorization> => {
    const captured = operationAuthority.resolution;
    if (input.signal.aborted) {
      throw operationError('voice_account_operation_cancelled');
    }
    if (captured.state !== 'resolved') {
      throw operationError(CREDENTIAL_SNAPSHOT_INDETERMINATE_CODE);
    }
    const accountAuthority = captured.authority;
    if (!isAuthorityCurrent(operationAuthority)) {
      throw operationError('voice_account_operation_cancelled');
    }
    const selectedSource = selectedVoiceCredentialOperationSource(
      accountAuthority.source.selection,
    );
    if (!selectedSource) {
      throw operationError('credential_unavailable');
    }
    const authorization = resolveVoiceCredentialOperationAuthorization({
      pluginId: input.contribution.pluginId,
      contributionId: input.contribution.localId,
      contribution: input.declaration,
      selectedSource,
      phase: input.phase,
      operationId,
    });
    if (!authorization) {
      throw operationError('voice_account_operation_unauthorized');
    }
    if (authorization.projection.kind === 'materializedHttpHeaders') {
      if (accountAuthority.source.selection.kind !== 'connectedAccount') {
        throw operationError('voice_account_operation_unauthorized');
      }
      if (!input.materializeConnectedAccountHeaders) {
        throw operationError('credential_unavailable');
      }
      return authorization;
    }
    if (accountAuthority.source.selection.kind !== 'savedSecret' || !accountAuthority.secret) {
      throw operationError('credential_unavailable');
    }
    if (
      requiredRecipientContractDigest
      && accountAuthority.binding?.approvedRecipientContractDigest
        !== requiredRecipientContractDigest
    ) {
      throw operationError('credential_access_review_required');
    }
    return authorization;
  };
  const inspectAvailability = async (): Promise<void> => {
    for (const [operationId, operationAuthority] of operationAuthorities) {
      await inspectOperationAvailability(operationId, operationAuthority);
    }
  };
  return Object.freeze({
    inspectAvailability,
    async request(request) {
      const operationSignal = composeAccountOperationSignal(input.signal, request.signal);
      let selectedOperationAuthority: AccountOperationCredentialAuthority | null = null;
      try {
        if (operationSignal.signal.aborted || !input.isCurrent()) {
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
        const operationAuthority = operationAuthorities.get(operation.id);
        if (!operationAuthority) {
          throw operationError('voice_account_operation_unauthorized');
        }
        selectedOperationAuthority = operationAuthority;
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
        const authorization = await inspectOperationAvailability(operation.id, operationAuthority);
        const capturedAuthority = operationAuthority.resolution;
        if (capturedAuthority.state !== 'resolved') {
          throw operationError(CREDENTIAL_SNAPSHOT_INDETERMINATE_CODE);
        }
        const accountAuthority = capturedAuthority.authority;
        let credentialHeaders: Readonly<Record<string, string>>;
        let sourceCredentials: readonly string[];
        if (authorization.projection.kind === 'materializedHttpHeaders') {
          if (accountAuthority.source.selection.kind !== 'connectedAccount') {
            throw operationError('voice_account_operation_unauthorized');
          }
          const returned = await input.materializeConnectedAccountHeaders?.({
            operationId: operation.id,
            selection: accountAuthority.source.selection.target,
            signal: operationSignal.signal,
          });
          if (!returned) throw operationError('credential_unavailable');
          const allowedHeaderNames = new Set(
            authorization.projection.allowedHeaderNames.map((name) => name.toLowerCase()),
          );
          const requiredHeaderNames = new Set(
            authorization.projection.requiredHeaderNames.map((name) => name.toLowerCase()),
          );
          const normalized = new Map<string, string>();
          for (const [rawName, value] of Object.entries(returned)) {
            const name = rawName.trim().toLowerCase();
            if (
              !/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name)
              || typeof value !== 'string'
              || value.length === 0
              || /[\r\n]/u.test(value)
              || normalized.has(name)
              || !allowedHeaderNames.has(name)
              || hasHeader(materialized.headers, name)
            ) {
              throw operationError('voice_account_operation_unauthorized');
            }
            normalized.set(name, value);
          }
          if ([...requiredHeaderNames].some((name) => !normalized.has(name))) {
            throw operationError('credential_unavailable');
          }
          credentialHeaders = Object.freeze(Object.fromEntries(normalized));
          sourceCredentials = Object.freeze([...normalized.values()]);
        } else {
          const capturedSecret = accountAuthority.secret;
          if (accountAuthority.source.selection.kind !== 'savedSecret' || !capturedSecret) {
            throw operationError('voice_account_operation_unauthorized');
          }
          if (!isAuthorityCurrent(operationAuthority)) {
            throw operationError('voice_account_operation_cancelled');
          }
          const materializeSecret = input.materializeSecret
            ?? (() => sync.decryptSecretValue(capturedSecret.encryptedValue));
          const sourceCredential = await materializeSecret();
          if (!sourceCredential) throw operationError('credential_unavailable');
          credentialHeaders = Object.freeze({
            [operation.request.credential.name]: operation.request.credential.format === 'bearer'
              ? `Bearer ${sourceCredential}`
              : sourceCredential,
          });
          sourceCredentials = Object.freeze([sourceCredential]);
        }
        if (operationSignal.signal.aborted || !isAuthorityCurrent(operationAuthority)) {
          throw operationError('voice_account_operation_cancelled');
        }
        const requestBody = materialized.body ? Uint8Array.from(materialized.body).buffer : null;
        const response = await fetchImpl(materialized.url, {
          method: materialized.method,
          headers: {
            ...materialized.headers,
            ...credentialHeaders,
          },
          ...(requestBody ? { body: requestBody } : {}),
          redirect: 'error',
          signal: operationSignal.signal,
        });
        if (operationSignal.signal.aborted || !isAuthorityCurrent(operationAuthority)) {
          await response.body?.cancel().catch(() => undefined);
          throw operationError('voice_account_operation_cancelled');
        }
        const responseContentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
        if (response.redirected) {
          await response.body?.cancel().catch(() => undefined);
          throw operationError(
            'provider_response_invalid',
            responseFailure(response, 'redirect'),
          );
        }
        const httpFailure = classifyVoiceProviderHttpFailure(response.status);
        if (httpFailure) {
          await response.body?.cancel().catch(() => undefined);
          throw operationError(
            httpFailure,
            responseFailure(response, 'http_status'),
          );
        }
        if (!operation.response.contentTypes.includes(responseContentType)) {
          await response.body?.cancel().catch(() => undefined);
          throw operationError(
            'provider_response_invalid',
            responseFailure(response, 'content_type'),
          );
        }
        const responseBody = await readBoundedBody(
          response,
          operation.response.maxBytes,
          operationSignal.signal,
        );
        if (operationSignal.signal.aborted || !isAuthorityCurrent(operationAuthority)) {
          throw operationError('voice_account_operation_cancelled');
        }
        const body = projectJsonBody(
          response,
          responseBody,
          sourceCredentials,
          operation.response.maxBytes,
        );
        return Object.freeze({
          status: response.status,
          finalUrl: materialized.url,
          headers: Object.freeze({ 'content-type': responseContentType }),
          body,
        });
      } catch (error) {
        if (
          operationSignal.signal.aborted
          || !input.isCurrent()
          || (selectedOperationAuthority !== null
            && selectedOperationAuthority.resolution.state === 'resolved'
            && !isAuthorityCurrent(selectedOperationAuthority))
        ) {
          throw operationError('voice_account_operation_cancelled');
        }
        throw error;
      } finally {
        operationSignal.dispose();
      }
    },
  });
}
