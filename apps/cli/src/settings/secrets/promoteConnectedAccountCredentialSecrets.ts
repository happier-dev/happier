import type { SharedSavedSecretPromoteInputV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import type { QualifiedConnectedAccountCredentialMutationSuccessV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type { StoredCredentials } from '@/persistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { prepareSavedSecretResourceCreateForOperation, promoteSavedSecretResourceForOperation } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';

export type ConnectedAccountCredentialSecretV1 = Readonly<{ resourceId: string; displayName: string; kind: 'apiKey'; value: string }>;
type PromotionResult = Readonly<{ status: 'applied'; credential?: ReturnType<typeof QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse> }>
  | Readonly<{ status: 'conflict' | 'unavailable' | 'outcome_unknown' | 'invalid' }>;

/**
 * A Connected Account credential whose declared secret keys are new Saved
 * Secret resources: the resources and the credential that references them
 * commit in the Saved Secret owner's one promotion transaction, or neither.
 * Shared by the Account-direct Action host and the daemon's settlement.
 */
export async function promoteConnectedAccountCredentialSecrets(input: Readonly<{
  credentials: StoredCredentials;
  accountMode: 'plain' | 'e2ee';
  secrets: readonly ConnectedAccountCredentialSecretV1[];
  credential: NonNullable<SharedSavedSecretPromoteInputV1['connectedAccountCredentialMutation']>;
  operationContext?: SavedSecretOperationContextV1;
  signal?: AbortSignal;
  authorizeRequest?: (request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
}>): Promise<PromotionResult> {
  const accountId = readAccountIdFromToken(input.credentials.token);
  if (!accountId) return { status: 'unavailable' };
  const [first, ...additional] = input.secrets.map(secret => prepareSavedSecretResourceCreateForOperation({ credentials: input.credentials,
    accountId, accountMode: input.accountMode, resourceId: secret.resourceId, displayName: secret.displayName, kind: secret.kind,
    value: secret.value }));
  if (!first) return { status: 'invalid' };
  const result = await promoteSavedSecretResourceForOperation({
    expectedScopeKey: resolveAccountSettingsScopeKey(input.credentials),
    ...(input.operationContext ? { operationContext: input.operationContext } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.authorizeRequest ? { authorizeRequest: input.authorizeRequest } : {}),
    input: { ...first, ...(additional.length ? { additionalSavedSecretResources: additional } : {}), nextSettings: null, profileMutations: [],
      referenceCensus: { scope: 'catalogs', accountMode: input.accountMode, catalogs: {} }, connectedAccountCredentialMutation: input.credential },
  });
  if (result.status !== 'applied') return { status: result.status };
  return result.connectedAccountCredential ? { status: 'applied', credential: { success: true, ...result.connectedAccountCredential } }
    : { status: 'applied' };
}
