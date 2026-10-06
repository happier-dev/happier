import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';

import {
  readProtectedLocalStateFile,
  removeProtectedLocalStateFile,
  verifyProtectedLocalStatePath,
  writeProtectedLocalStateFileAtomic,
  type ProtectedLocalStateOptions,
} from '@/utils/fs/protectedLocalState';

export type CliAccountServiceAdvertisedMethods = Readonly<{
  keyLoginAvailable: boolean;
  oauthProviderIds: readonly string[];
  preferredProvisionProviderId: string | null;
}>;

export type CliAccountServiceSelection = Readonly<{
  endpoint: string;
  serverIdentityId: string;
  canonicalServerUrl: string;
  advertisedMethods: CliAccountServiceAdvertisedMethods;
}>;

export type CliAccountServiceSelectionAuthority = Pick<
  CliAccountServiceSelection,
  'endpoint' | 'serverIdentityId' | 'canonicalServerUrl'
>;

export type CliAccountServiceRestrictedCredential = Readonly<{ token: string }>;

export type CliAccountServiceAuthenticationOutcome =
  | Readonly<{ kind: 'authenticated'; credential: CliAccountServiceRestrictedCredential }>
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'timed_out' }>
  | Readonly<{ kind: 'failed'; error: unknown }>;

export type CliAccountServiceSessionErrorCode =
  | 'account_service_invalid_selection'
  | 'account_service_invalid_credential'
  | 'account_service_selection_mismatch'
  | 'account_service_storage_corrupt'
  | 'account_service_storage_unsafe';

export class CliAccountServiceSessionError extends Error {
  readonly code: CliAccountServiceSessionErrorCode;

  constructor(code: CliAccountServiceSessionErrorCode) {
    super(code);
    this.name = 'CliAccountServiceSessionError';
    this.code = code;
  }
}

export type CliAccountServiceSessionOwner = Readonly<{
  readSelection(): Promise<CliAccountServiceSelectionAuthority | null>;
  readCredential(service: CliAccountServiceSelectionAuthority): Promise<CliAccountServiceRestrictedCredential | null>;
  selectService(service: CliAccountServiceSelection): Promise<CliAccountServiceSelection>;
  replaceCredential(input: Readonly<{
    service: CliAccountServiceSelection;
    credential: CliAccountServiceRestrictedCredential;
  }>): Promise<void>;
  rejectCredential(service: CliAccountServiceSelection): Promise<void>;
  authenticate(input: Readonly<{
    service: CliAccountServiceSelection;
    timeoutMs: number;
    signal?: AbortSignal;
    credentialCustody?: 'selected_service' | 'transient';
    acquireCredential(signal: AbortSignal): Promise<CliAccountServiceRestrictedCredential>;
  }>): Promise<CliAccountServiceAuthenticationOutcome>;
  logout(): Promise<void>;
  clear(): Promise<void>;
}>;

type StoredCliAccountServiceSessionV1 = Readonly<{
  v: 1;
  selectedService: CliAccountServiceSelectionAuthority;
  restrictedCredential: CliAccountServiceRestrictedCredential | null;
}>;

type PendingAuthentication = {
  readonly service: CliAccountServiceSelection;
  readonly credentialCustody: 'selected_service' | 'transient';
  readonly controller: AbortController;
  readonly outcome: Promise<CliAccountServiceAuthenticationOutcome>;
  readonly resolve: (outcome: CliAccountServiceAuthenticationOutcome) => void;
  detachExternalAbort: () => void;
  timer: ReturnType<typeof setTimeout> | null;
};

const STORAGE_OPTIONS: ProtectedLocalStateOptions = Object.freeze({ authority: 'admitted' });
const SESSION_NAMESPACE = 'account-service';
const SESSION_FILE = 'session-v1.json';

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function normalizeEndpoint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:')
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/+$/u, '');
    return url.toString().replace(/\/$/u, '');
  } catch {
    return null;
  }
}

function normalizeProviderId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeAdvertisedMethods(value: unknown): CliAccountServiceAdvertisedMethods | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'keyLoginAvailable',
    'oauthProviderIds',
    'preferredProvisionProviderId',
  ])) {
    return null;
  }
  if (typeof value.keyLoginAvailable !== 'boolean' || !Array.isArray(value.oauthProviderIds)) {
    return null;
  }
  const oauthProviderIds: string[] = [];
  for (const candidate of value.oauthProviderIds) {
    const providerId = normalizeProviderId(candidate);
    if (!providerId || oauthProviderIds.includes(providerId)) return null;
    oauthProviderIds.push(providerId);
  }
  const preferredProvisionProviderId = value.preferredProvisionProviderId === null
    ? null
    : normalizeProviderId(value.preferredProvisionProviderId);
  if (
    value.preferredProvisionProviderId !== null
    && (
      !preferredProvisionProviderId
      || !oauthProviderIds.includes(preferredProvisionProviderId)
    )
  ) {
    return null;
  }
  return {
    keyLoginAvailable: value.keyLoginAvailable,
    oauthProviderIds,
    preferredProvisionProviderId,
  };
}

function normalizeSelection(value: unknown): CliAccountServiceSelection | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'endpoint',
    'serverIdentityId',
    'canonicalServerUrl',
    'advertisedMethods',
  ])) {
    return null;
  }
  const endpoint = normalizeEndpoint(value.endpoint);
  const canonicalServerUrl = normalizeEndpoint(value.canonicalServerUrl);
  const serverIdentityId = normalizeServerIdentityIdCapability(value.serverIdentityId);
  const advertisedMethods = normalizeAdvertisedMethods(value.advertisedMethods);
  if (!endpoint || !canonicalServerUrl || !serverIdentityId || !advertisedMethods) return null;
  return { endpoint, serverIdentityId, canonicalServerUrl, advertisedMethods };
}

function normalizeSelectionAuthority(value: unknown): CliAccountServiceSelectionAuthority | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'endpoint',
    'serverIdentityId',
    'canonicalServerUrl',
  ])) {
    return null;
  }
  const endpoint = normalizeEndpoint(value.endpoint);
  const canonicalServerUrl = normalizeEndpoint(value.canonicalServerUrl);
  const serverIdentityId = normalizeServerIdentityIdCapability(value.serverIdentityId);
  if (!endpoint || !canonicalServerUrl || !serverIdentityId) return null;
  return { endpoint, serverIdentityId, canonicalServerUrl };
}

function normalizeCredential(value: unknown): CliAccountServiceRestrictedCredential | null {
  if (!isRecord(value) || !hasExactKeys(value, ['token'])) return null;
  if (typeof value.token !== 'string' || !value.token.trim()) return null;
  return { token: value.token };
}

function parseStoredRecord(value: unknown): StoredCliAccountServiceSessionV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, ['v', 'selectedService', 'restrictedCredential'])) {
    return null;
  }
  if (value.v !== 1) return null;
  const selectedService = normalizeSelectionAuthority(value.selectedService);
  const restrictedCredential = value.restrictedCredential === null
    ? null
    : normalizeCredential(value.restrictedCredential);
  if (!selectedService || (value.restrictedCredential !== null && !restrictedCredential)) return null;

  return { v: 1, selectedService, restrictedCredential };
}

function requireSelection(value: CliAccountServiceSelection): CliAccountServiceSelection {
  const normalized = normalizeSelection(value);
  if (!normalized) throw new CliAccountServiceSessionError('account_service_invalid_selection');
  return normalized;
}

function requireSelectionAuthority(
  value: CliAccountServiceSelectionAuthority,
): CliAccountServiceSelectionAuthority {
  const normalized = isRecord(value)
    ? normalizeSelectionAuthority({
        endpoint: value.endpoint,
        serverIdentityId: value.serverIdentityId,
        canonicalServerUrl: value.canonicalServerUrl,
      })
    : null;
  if (!normalized) throw new CliAccountServiceSessionError('account_service_invalid_selection');
  return normalized;
}

function requireCredential(
  value: CliAccountServiceRestrictedCredential,
): CliAccountServiceRestrictedCredential {
  const normalized = normalizeCredential(value);
  if (!normalized) throw new CliAccountServiceSessionError('account_service_invalid_credential');
  return normalized;
}

function selectionsHaveSameCredentialAuthority(
  left: CliAccountServiceSelectionAuthority,
  right: CliAccountServiceSelectionAuthority,
): boolean {
  return left.endpoint === right.endpoint
    && left.serverIdentityId === right.serverIdentityId
    && left.canonicalServerUrl === right.canonicalServerUrl;
}

function requireSelectedService(
  record: StoredCliAccountServiceSessionV1 | null,
  service: CliAccountServiceSelection,
): StoredCliAccountServiceSessionV1 {
  if (!record || !selectionsHaveSameCredentialAuthority(record.selectedService, service)) {
    throw new CliAccountServiceSessionError('account_service_selection_mismatch');
  }
  return record;
}

function asStorageFailure(error: unknown): CliAccountServiceSessionError {
  if (error instanceof CliAccountServiceSessionError) return error;
  return new CliAccountServiceSessionError('account_service_storage_unsafe');
}

function combineStorageOptions(
  options: ProtectedLocalStateOptions | undefined,
): ProtectedLocalStateOptions {
  return { ...STORAGE_OPTIONS, ...options, authority: 'admitted' };
}

export function resolveCliAccountServiceSessionRecordPath(happyHomeDir: string): string {
  if (!happyHomeDir || happyHomeDir.trim() !== happyHomeDir) {
    throw new TypeError('Happier home directory must be a canonical non-empty path');
  }
  return join(happyHomeDir, SESSION_NAMESPACE, SESSION_FILE);
}

export function createCliAccountServiceSessionOwner(input: Readonly<{
  happyHomeDir: string;
  protectedLocalStateOptions?: ProtectedLocalStateOptions;
}>): CliAccountServiceSessionOwner {
  const recordPath = resolveCliAccountServiceSessionRecordPath(input.happyHomeDir);
  const namespacePath = dirname(recordPath);
  const protectedLocalStateOptions = combineStorageOptions(input.protectedLocalStateOptions);
  let serializationTail: Promise<void> = Promise.resolve();
  let pendingAuthentication: PendingAuthentication | null = null;

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = serializationTail.then(operation, operation);
    serializationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const readStoredRecord = async (): Promise<StoredCliAccountServiceSessionV1 | null> => {
    try {
      try {
        await lstat(namespacePath);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return null;
        throw error;
      }
      await verifyProtectedLocalStatePath(
        namespacePath,
        'directory',
        protectedLocalStateOptions,
      );

      let raw: string;
      try {
        raw = await readProtectedLocalStateFile(recordPath, protectedLocalStateOptions);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return null;
        throw error;
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        throw new CliAccountServiceSessionError('account_service_storage_corrupt');
      }
      const record = parseStoredRecord(decoded);
      if (!record) {
        throw new CliAccountServiceSessionError('account_service_storage_corrupt');
      }
      return record;
    } catch (error) {
      throw asStorageFailure(error);
    }
  };

  const writeStoredRecord = async (record: StoredCliAccountServiceSessionV1): Promise<void> => {
    try {
      await writeProtectedLocalStateFileAtomic(
        recordPath,
        JSON.stringify(record),
        protectedLocalStateOptions,
      );
    } catch (error) {
      throw asStorageFailure(error);
    }
  };

  const resolvePending = (
    attempt: PendingAuthentication,
    outcome: CliAccountServiceAuthenticationOutcome,
  ): void => {
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = null;
    attempt.detachExternalAbort();
    attempt.detachExternalAbort = () => {};
    attempt.controller.abort();
    attempt.resolve(outcome);
  };

  const cancelPending = (
    outcome: Extract<CliAccountServiceAuthenticationOutcome, { kind: 'cancelled' | 'timed_out' }>,
    expected?: PendingAuthentication,
  ): boolean => {
    const attempt = pendingAuthentication;
    if (!attempt || (expected && attempt !== expected)) return false;
    pendingAuthentication = null;
    resolvePending(attempt, outcome);
    return true;
  };

  const completeAttemptWithCredential = async (
    attempt: PendingAuthentication,
    credentialInput: CliAccountServiceRestrictedCredential,
  ): Promise<void> => {
    await serialize(async () => {
      if (pendingAuthentication !== attempt) return;
      try {
        const credential = requireCredential(credentialInput);
        if (attempt.credentialCustody === 'selected_service') {
          const record = requireSelectedService(await readStoredRecord(), attempt.service);
          await writeStoredRecord({ ...record, restrictedCredential: credential });
        }
        pendingAuthentication = null;
        resolvePending(attempt, { kind: 'authenticated', credential });
      } catch (error) {
        pendingAuthentication = null;
        resolvePending(attempt, { kind: 'failed', error });
      }
    });
  };

  const completeAttemptWithFailure = async (
    attempt: PendingAuthentication,
    error: unknown,
  ): Promise<void> => {
    await serialize(async () => {
      if (pendingAuthentication !== attempt) return;
      pendingAuthentication = null;
      resolvePending(attempt, { kind: 'failed', error });
    });
  };

  return {
    async readSelection() {
      return await serialize(async () => (await readStoredRecord())?.selectedService ?? null);
    },

    async readCredential(serviceInput) {
      const service = requireSelectionAuthority(serviceInput);
      return await serialize(async () => {
        const record = await readStoredRecord();
        if (!record || !selectionsHaveSameCredentialAuthority(record.selectedService, service)) return null;
        return record.restrictedCredential;
      });
    },

    async selectService(serviceInput) {
      const service = requireSelection(serviceInput);
      return await serialize(async () => {
        let record: StoredCliAccountServiceSessionV1 | null;
        try {
          record = await readStoredRecord();
        } catch (error) {
          cancelPending({ kind: 'cancelled' });
          throw error;
        }
        if (record && selectionsHaveSameCredentialAuthority(record.selectedService, service)) {
          await writeStoredRecord({ ...record, selectedService: {
            endpoint: service.endpoint,
            serverIdentityId: service.serverIdentityId,
            canonicalServerUrl: service.canonicalServerUrl,
          } });
          return service;
        }
        cancelPending({ kind: 'cancelled' });
        await writeStoredRecord({
          v: 1,
          selectedService: {
            endpoint: service.endpoint,
            serverIdentityId: service.serverIdentityId,
            canonicalServerUrl: service.canonicalServerUrl,
          },
          restrictedCredential: null,
        });
        return service;
      });
    },

    async replaceCredential({ service: serviceInput, credential: credentialInput }) {
      const service = requireSelection(serviceInput);
      const credential = requireCredential(credentialInput);
      await serialize(async () => {
        const record = requireSelectedService(await readStoredRecord(), service);
        cancelPending({ kind: 'cancelled' });
        await writeStoredRecord({ ...record, restrictedCredential: credential });
      });
    },

    async rejectCredential(serviceInput) {
      const service = requireSelection(serviceInput);
      await serialize(async () => {
        const record = requireSelectedService(await readStoredRecord(), service);
        cancelPending({ kind: 'cancelled' });
        await writeStoredRecord({ ...record, restrictedCredential: null });
      });
    },

    async authenticate({
      service: serviceInput,
      timeoutMs,
      signal,
      credentialCustody = 'selected_service',
      acquireCredential,
    }) {
      const service = requireSelection(serviceInput);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new RangeError('Account Service authentication timeout must be a positive integer');
      }
      if (signal?.aborted) return { kind: 'cancelled' };

      const attempt = await serialize(async (): Promise<PendingAuthentication> => {
        if (credentialCustody === 'selected_service') {
          requireSelectedService(await readStoredRecord(), service);
        }
        cancelPending({ kind: 'cancelled' });
        const controller = new AbortController();
        let resolveOutcome!: (outcome: CliAccountServiceAuthenticationOutcome) => void;
        const outcome = new Promise<CliAccountServiceAuthenticationOutcome>((resolve) => {
          resolveOutcome = resolve;
        });
        const next: PendingAuthentication = {
          service,
          credentialCustody,
          controller,
          outcome,
          resolve: resolveOutcome,
          detachExternalAbort: () => {},
          timer: null,
        };
        pendingAuthentication = next;
        if (signal) {
          const onAbort = (): void => {
            void serialize(async () => {
              cancelPending({ kind: 'cancelled' }, next);
            });
          };
          signal.addEventListener('abort', onAbort, { once: true });
          next.detachExternalAbort = () => signal.removeEventListener('abort', onAbort);
        }
        next.timer = setTimeout(() => {
          void serialize(async () => {
            cancelPending({ kind: 'timed_out' }, next);
          });
        }, timeoutMs);
        if (signal?.aborted) cancelPending({ kind: 'cancelled' }, next);
        return next;
      });

      void Promise.resolve()
        .then(async () => await acquireCredential(attempt.controller.signal))
        .then(
          async (credential) => await completeAttemptWithCredential(attempt, credential),
          async (error) => await completeAttemptWithFailure(attempt, error),
        );
      return await attempt.outcome;
    },

    async logout() {
      await serialize(async () => {
        cancelPending({ kind: 'cancelled' });
        const record = await readStoredRecord();
        if (!record || record.restrictedCredential === null) return;
        await writeStoredRecord({ ...record, restrictedCredential: null });
      });
    },

    async clear() {
      await serialize(async () => {
        cancelPending({ kind: 'cancelled' });
        const record = await readStoredRecord();
        if (!record) return;
        try {
          await removeProtectedLocalStateFile(recordPath, protectedLocalStateOptions);
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw asStorageFailure(error);
        }
      });
    },
  };
}
