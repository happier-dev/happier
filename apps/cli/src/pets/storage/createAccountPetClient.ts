import {
  AccountPetCreateResponseV1Schema,
  type AccountPetCreateRequestV1,
  type AccountPetCreateResponseV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { readCredentials, type Credentials } from '@/persistence';

type AccountPetFetch = (url: string, init: RequestInit) => Promise<Response>;

const ACCOUNT_PETS_PATH = '/v1/account/pets';

function buildAccountPetsUrl(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, '')}${ACCOUNT_PETS_PATH}`;
}

export async function createAccountPetViaActiveServer(
  request: AccountPetCreateRequestV1,
  deps: Readonly<{
    serverUrl?: string;
    readCredentials?: () => Promise<Credentials | null>;
    fetcher?: AccountPetFetch;
  }> = {},
): Promise<AccountPetCreateResponseV1> {
  const credentials = await (deps.readCredentials ?? readCredentials)();
  if (!credentials) {
    return { ok: false, errorCode: 'internal_error', error: 'Account credentials are unavailable.' };
  }

  const response = await (deps.fetcher ?? fetch)(buildAccountPetsUrl(deps.serverUrl ?? configuration.apiServerUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  const raw = await response.json().catch(() => null);
  const parsed = AccountPetCreateResponseV1Schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return { ok: false, errorCode: 'internal_error', error: 'Account pet upload response was invalid.' };
}
