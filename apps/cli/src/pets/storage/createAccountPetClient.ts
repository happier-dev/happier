import { randomBytes } from 'node:crypto';

import { AccountPetCreateResponseV1Schema } from '@happier-dev/protocol/pets/accountLibrary';
import { validateAccountPetCreateRequestV1 } from '@happier-dev/protocol/pets/accountPetCreateValidation';
import { openAccountPetStoredEntryForModeV1, sealAccountPetPackageV1, type AccountPetEntryOpenModeV1 } from '@happier-dev/protocol/pets/accountPetEncryptionV1';
import type { AccountPetCreateRequestV1, AccountPetCreateResponseV1 } from '@happier-dev/protocol';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { hasUsableAccountSettingsEncryptionMaterial } from '@/settings/accountSettings/accountSettingsEncryptionMaterial';
import { inspectPetAtlasForAccountUpload } from '../validation/validatePetAtlas';

type AccountPetFetch = (url: string, init: RequestInit) => Promise<Response>;

const ACCOUNT_PETS_PATH = '/v1/account/pets';
const ACCOUNT_ENCRYPTION_PATH = '/v1/account/encryption';

function buildServerUrl(serverUrl: string, path: string): string {
  return `${serverUrl.replace(/\/+$/, '')}${path}`;
}

function failure(errorCode: 'internal_error' | 'invalid_request', error: string): AccountPetCreateResponseV1 {
  return { ok: false, errorCode, error };
}

/** Persisted Account mode decides whether the package travels for Home validation or sealed. */
async function resolveAccountPetWriteMode(input: Readonly<{
  credentials: StoredCredentials;
  serverUrl: string;
  fetcher: AccountPetFetch;
  headers: Record<string, string>;
}>): Promise<AccountPetEntryOpenModeV1 | null> {
  const mode = await readAccountEncryptionModeOnce({
    credentials: input.credentials,
    usage: 'fresh-authority',
    request: async () => {
      const response = await input.fetcher(buildServerUrl(input.serverUrl, ACCOUNT_ENCRYPTION_PATH), { method: 'GET', headers: input.headers });
      return { status: response.status, data: await response.json().catch(() => null) };
    },
  });
  if (mode.kind !== 'resolved') return null;
  if (mode.mode === 'plain') return { mode: 'plain' };
  if (!hasUsableAccountSettingsEncryptionMaterial(input.credentials)) return null;
  const encryption = input.credentials.encryption;
  return { mode: 'e2ee', material: encryption.type === 'legacy'
    ? { type: 'legacy', secret: encryption.secret }
    : { type: 'dataKey', machineKey: encryption.machineKey } };
}

export async function createAccountPetViaActiveServer(
  request: AccountPetCreateRequestV1,
  deps: Readonly<{
    serverUrl?: string;
    readCredentials?: () => Promise<StoredCredentials | null>;
    fetcher?: AccountPetFetch;
  }> = {},
): Promise<AccountPetCreateResponseV1> {
  const credentials = await (deps.readCredentials ?? readStoredCredentials)();
  if (!credentials) {
    return failure('internal_error', 'Account credentials are unavailable.');
  }
  const fetcher = deps.fetcher ?? fetch;
  const serverUrl = deps.serverUrl ?? resolveServerHttpBaseUrl();
  const headers = {
    ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
    Authorization: `Bearer ${credentials.token}`,
  };

  let account: AccountPetEntryOpenModeV1 | null;
  try {
    account = await resolveAccountPetWriteMode({ credentials, serverUrl, fetcher, headers });
  } catch {
    account = null;
  }
  if (!account) return failure('internal_error', 'Account encryption mode or material is unavailable.');

  let body: unknown = request;
  if (account.mode === 'e2ee') {
    // The Home sees only ciphertext for an E2EE Account, so the package is admitted here first.
    const validated = await validateAccountPetCreateRequestV1(request, { inspectAtlas: inspectPetAtlasForAccountUpload });
    if (!validated.ok) return failure('invalid_request', `Account pet package is invalid (${validated.reason}).`);
    const sealed = sealAccountPetPackageV1({ validated, material: account.material, randomBytes: length => new Uint8Array(randomBytes(length)) });
    if (!sealed.ok) return failure('invalid_request', `Account pet package is invalid (${sealed.reason}).`);
    body = sealed.request;
  }

  const response = await fetcher(buildServerUrl(serverUrl, ACCOUNT_PETS_PATH), {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const raw = await response.json().catch(() => null);
  const parsed = AccountPetCreateResponseV1Schema.safeParse(raw);
  if (!parsed.success) return failure('internal_error', 'Account pet upload response was invalid.');
  if (!parsed.data.ok) return parsed.data;
  // Importers receive the opened entry; an unopenable sealed response never becomes plaintext.
  const pet = openAccountPetStoredEntryForModeV1(parsed.data.pet, account);
  if (!pet) return failure('internal_error', 'Account pet upload response could not be opened.');
  return { ...parsed.data, pet };
}
