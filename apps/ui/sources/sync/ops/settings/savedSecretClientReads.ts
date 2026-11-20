import {
  projectSharedSavedSecretRecipientsV1,
  SharedSavedSecretDisclosuresListInputV1Schema,
  SharedSavedSecretRecipientsListInputV1Schema,
} from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import type { SharedSavedSecretClientReadActionIdV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionIdsV1';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readSavedSecretDisclosureHistoryInContext } from '@/sync/ops/settings/savedSecretDisclosure';
import { readSavedSecretResourceRecipientReadiness } from '@/sync/ops/settings/savedSecretResourceOperations';

type ClientRead = (
  account: LazyActionAccountContext,
  input: unknown,
  signal: AbortSignal | undefined,
) => Promise<unknown>;

function refused(code: string) {
  return { ok: false as const, errorCode: code, error: code };
}

/**
 * Agent/MCP parity for the Saved Secret screen's value-free reads. Each Action reuses the exact reader the
 * screen mounts, under the answering app's own Home authority, so the Home's owner-only admission decides
 * both. Recipient readiness drops content keys; envelope preparation stays with the repair owner.
 */
const SAVED_SECRET_CLIENT_READS = {
  'secrets.shared.disclosures.list': async (account, input, signal) => {
    const result = await readSavedSecretDisclosureHistoryInContext(
      account,
      SharedSavedSecretDisclosuresListInputV1Schema.parse(input),
      signal,
    );
    return result.ok
      ? result.value
      : refused(result.failure.code ?? result.failure.kind);
  },
  'secrets.shared.recipients.list': async (account, input) => {
    const { resourceId } =
      SharedSavedSecretRecipientsListInputV1Schema.parse(input);
    account.assertCurrent();
    const census = await readSavedSecretResourceRecipientReadiness({
      scope: { serverId: account.serverId, accountId: account.accountId },
      resourceId,
    });
    account.assertCurrent();
    return census.ok
      ? projectSharedSavedSecretRecipientsV1({ resourceId, ...census })
      : refused(census.code);
  },
} as const satisfies Record<SharedSavedSecretClientReadActionIdV1, ClientRead>;

export async function executeSavedSecretClientRead(
  account: LazyActionAccountContext,
  actionId: SharedSavedSecretClientReadActionIdV1,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return await SAVED_SECRET_CLIENT_READS[actionId](account, input, signal);
}
