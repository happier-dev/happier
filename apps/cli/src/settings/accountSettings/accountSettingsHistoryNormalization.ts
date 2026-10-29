import { randomBytes } from 'node:crypto';
import axios from '@/api/client/credentialAxios';

import { normalizeAccountSettingsHistoryClientV1,
  type AccountSettingsHistoryCleanupResultV1, type AccountSettingsHistorySavedSecretRecoveryV1,
  type AccountSettingsHistoryNormalizationCheckpointV1 } from '@happier-dev/protocol/account/settings/accountSettingsHistoryClientV1';
import type { AccountSettingsHistoryDestinationAuthorityV1 } from '@happier-dev/protocol/account/settings/accountSettingsHistoryRestoreV1';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { StoredCredentials } from '@/persistence';
import { parseSettingsFromContent, sealAccountSettingsV2RawContent } from './updateAccountSettingsV2WithRetry';
import { resolveAccountSettingsScopeKey } from './accountSettingsScopeKey';
import { runWithRequesterSessionCurrentnessCheckpoint, runWithoutRequesterSessionCurrentnessCheckpoint } from '@/daemon/sessionEncryption/requesterCurrentness';

// Keep Protocol's completion evidence with the captured credential lifetime, Account and Home.
// Protocol still recaptures head/destination authority; this never caches admission.
const historyCheckpoints = new WeakMap<StoredCredentials, Map<string, AccountSettingsHistoryNormalizationCheckpointV1>>();

class AccountSettingsHistoryUnavailableError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AccountSettingsHistoryUnavailableError';
  }
}

/** Borrow the importing operation's captured Home, credentials and lifetime. */
export async function normalizeCliAccountSettingsHistoryAfterTransfer(input: Readonly<{
  credentials: StoredCredentials;
  serverBaseUrl: string;
  isCurrent(): boolean | Promise<boolean>;
  signal?: AbortSignal;
  destinationAuthority: AccountSettingsHistoryDestinationAuthorityV1;
  expectedProfileTransferRevision?: number | 'absent';
  savedSecretRecovery?: AccountSettingsHistorySavedSecretRecoveryV1;
  authorizeRequest?: (request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
}>): Promise<AccountSettingsHistoryCleanupResultV1> {
  const serverBaseUrl = input.serverBaseUrl.replace(/\/+$/, '');
  const checkpointKey = `${serverBaseUrl}\0${resolveAccountSettingsScopeKey(input.credentials)}`;
  let checkpoints = historyCheckpoints.get(input.credentials);
  if (!checkpoints) {
    checkpoints = new Map();
    historyCheckpoints.set(input.credentials, checkpoints);
  }
  let checkpoint = checkpoints.get(checkpointKey);
  if (!checkpoint) {
    checkpoint = {};
    checkpoints.set(checkpointKey, checkpoint);
  }
  const headersFor = (request: Readonly<{ method: string; path: string; body?: unknown }>) => {
    const authorization = input.authorizeRequest ? input.authorizeRequest(request)
      : { Authorization: `Bearer ${input.credentials.token}` };
    if (!authorization) throw new AccountSettingsHistoryUnavailableError(403, 'Captured Action authorization unavailable');
    return { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...authorization };
  };
  const isCurrent = async () => !input.signal?.aborted && await input.isCurrent();
  const unavailable = (status: number, message: string): never => {
    throw new AccountSettingsHistoryUnavailableError(status, message);
  };
  // Optional history work can outlive the catalog's first-ready publication.
  // Own its read checkpoint rather than borrowing one that can finish earlier.
  // Only an actual history mutation leaves it for fresh requester authority.
  return runWithRequesterSessionCurrentnessCheckpoint(() => normalizeAccountSettingsHistoryClientV1({ checkpoint, destinationAuthority: input.destinationAuthority,
    ...(input.savedSecretRecovery ? { savedSecretRecovery: input.savedSecretRecovery } : {}),
    ...(input.expectedProfileTransferRevision === undefined ? {} : { expectedProfileTransferRevision: input.expectedProfileTransferRevision }), ports: {
    isCurrent,
    unavailable,
    request: async (path, request) => {
      const dispatch = async () => {
        const options = { headers: headersFor({ method: request.method, path,
          ...(request.body === undefined ? {} : { body: request.body }) }),
          validateStatus: () => true, ...(input.signal ? { signal: input.signal } : {}) };
        const response = request.method === 'GET'
          ? await axios.get<unknown>(`${serverBaseUrl}${path}`, options)
          : await axios.post<unknown>(`${serverBaseUrl}${path}`, request.body, options);
        return { status: response.status, data: response.data };
      };
      if (request.method === 'GET') return dispatch();
      return runWithoutRequesterSessionCurrentnessCheckpoint(async () => {
        if (!await isCurrent()) unavailable(0, 'Captured Account Settings scope retired');
        return dispatch();
      });
    },
    readCurrentness: () => fetchAccountEncryptionCurrentness({ token: input.credentials.token,
      serverBaseUrl, authorizationHeaders: headersFor({ method: 'GET', path: '/v1/account/encryption/currentness' }),
      ...(input.signal ? { signal: input.signal } : {}) }),
    resolveTransferMaterial: async mode => {
      if (mode === 'plain') return null;
      if (!await isCurrent()) unavailable(0, 'Captured Account Settings scope retired');
      const admitted = await resolveCliAccountStorageContext({ credentials: input.credentials,
        serverBaseUrl, authorizationHeaders: headersFor({ method: 'GET', path: '/v1/account/encryption/currentness' }),
        ...(input.signal ? { signal: input.signal } : {}) });
      if (!await isCurrent()) unavailable(0, 'Captured Account Settings scope retired');
      if (admitted.mode !== mode) unavailable(0, 'Account encryption currentness changed');
      return admitted.material;
    },
    openSnapshot: async content => (await parseSettingsFromContent({ content,
      credentials: input.credentials, emptyEnvelopeKind: content.t })).raw,
    resealSnapshot: (raw, recorded) => sealAccountSettingsV2RawContent({ credentials: input.credentials,
      raw, envelopeKind: recorded.t, randomBytes: size => new Uint8Array(randomBytes(size)) }),
  } }));
}
