import type {
  AccountEncryptionMigrateRequest,
  AccountEncryptionMigrateSuccessResponse,
  SessionDraftRecordV1,
} from '@happier-dev/protocol';
import { canonicalSessionDraftAddressV1 } from '@happier-dev/protocol';

type Params = Readonly<{
  request: AccountEncryptionMigrateRequest;
  migrate(request: AccountEncryptionMigrateRequest): Promise<AccountEncryptionMigrateSuccessResponse>;
  activateTargetMode(): void | Promise<void>;
  acknowledgeSessionDrafts(records: readonly SessionDraftRecordV1[]): void | Promise<void>;
}>;

export async function runAccountEncryptionModeMigration(
  params: Params,
): Promise<AccountEncryptionMigrateSuccessResponse> {
  const result = await params.migrate(params.request);
  const expectedItems = params.request.sessionDrafts?.items ?? [];
  let migratedRecords: readonly SessionDraftRecordV1[] = [];

  if (expectedItems.length > 0) {
    migratedRecords = result.sessionDrafts?.records ?? [];
    const expectedByAddress = new Map(expectedItems.map((item) => [
      canonicalSessionDraftAddressV1(item.address),
      item,
    ]));
    const responseAddresses = new Set<string>();
    const coverageIsExact = migratedRecords.length === expectedItems.length
      && migratedRecords.every((record) => {
        const address = canonicalSessionDraftAddressV1(record.address);
        const expected = expectedByAddress.get(address);
        if (!expected || responseAddresses.has(address)) return false;
        responseAddresses.add(address);
        return record.address.kind === 'newSession'
          && record.revision === expected.expectedRevision + 1
          && record.content !== null
          && JSON.stringify(record.content) === JSON.stringify(expected.content);
      });
    if (!coverageIsExact) {
      throw new Error('Invalid session draft migration response');
    }
  }

  await params.activateTargetMode();
  if (migratedRecords.length > 0) {
    await params.acknowledgeSessionDrafts(migratedRecords);
  }
  return result;
}
