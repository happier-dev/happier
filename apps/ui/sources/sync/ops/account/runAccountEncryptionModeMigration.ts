import { canonicalSessionDraftAddressV2, type SessionDraftRecordV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { AccountEncryptionMigrateRequest, AccountEncryptionMigrateSuccessResponse } from '@happier-dev/protocol/account/encryptionMigrate';

type Params = Readonly<{
  request: AccountEncryptionMigrateRequest;
  migrate(request: AccountEncryptionMigrateRequest): Promise<AccountEncryptionMigrateSuccessResponse>;
  activateTargetMode(): void | Promise<void>;
  acknowledgeSessionDrafts(records: readonly SessionDraftRecordV2[]): void | Promise<void>;
  isCurrent?(): boolean;
}>;

export async function runAccountEncryptionModeMigration(
  params: Params,
): Promise<AccountEncryptionMigrateSuccessResponse> {
  const result = await params.migrate(params.request);
  // A committed migration response remains authoritative, but a Home switch
  // retires local projection and acknowledgement. Do not turn that committed
  // result into a false failure or publish it into the newly selected Home.
  if (params.isCurrent && !params.isCurrent()) return result;
  const expectedItems = params.request.sessionDrafts?.items ?? [];
  let migratedRecords: readonly SessionDraftRecordV2[] = [];

  if (params.request.sessionDrafts && "v" in params.request.sessionDrafts
    && (!result.sessionDrafts || !("v" in result.sessionDrafts)
      || result.sessionDrafts.v !== params.request.sessionDrafts.v)) {
    throw new Error('Invalid session draft migration response');
  }

  if (expectedItems.length > 0) {
    migratedRecords = result.sessionDrafts?.records ?? [];
    const expectedByAddress = new Map(expectedItems.map((item) => [
      canonicalSessionDraftAddressV2(item.address),
      item,
    ]));
    const responseAddresses = new Set<string>();
    const coverageIsExact = migratedRecords.length === expectedItems.length
      && migratedRecords.every((record) => {
        const canonicalAddress = canonicalSessionDraftAddressV2(record.address);
        const expected = expectedByAddress.get(canonicalAddress);
        if (!expected || responseAddresses.has(canonicalAddress)) return false;
        responseAddresses.add(canonicalAddress);
        return record.address.kind === 'newSession'
          && record.revision === expected.expectedRevision + 1
          && record.content !== null
          && pluginJsonValuesEqual(record.content, expected.content);
      });
    if (!coverageIsExact) {
      throw new Error('Invalid session draft migration response');
    }
  }

  const expectedMemory = params.request.authoringMemory?.items ?? [];
  if (expectedMemory.length > 0) {
    const rows = result.authoringMemory?.rows ?? [];
    const expectedByKey = new Map(expectedMemory.map((item) => [item.key, item]));
    const seen = new Set<string>();
    if (rows.length !== expectedMemory.length || !rows.every((row) => {
      const expected = expectedByKey.get(row.key);
      if (!expected || seen.has(row.key)) return false;
      seen.add(row.key);
      return row.revision === expected.expectedRevision + 1 && row.content !== null
        && pluginJsonValuesEqual(row.content, expected.content);
    })) throw new Error('Invalid authoring memory migration response');
  }

  await params.activateTargetMode();
  if (migratedRecords.length > 0) {
    await params.acknowledgeSessionDrafts(migratedRecords);
  }
  return result;
}
