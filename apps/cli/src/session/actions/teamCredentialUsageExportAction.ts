import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import {
  buildTeamCredentialUsageExportFromRecipientProjectionV1,
  TeamCredentialUsageQueryResultV1Schema,
} from '@happier-dev/protocol/teams';

import type { StoredCredentials } from '@/persistence';
import { deriveCliPrivateLabelAccountKey, openCliPrivateLabel } from '@/api/privateLabels';

type HomeDomainAction = NonNullable<ActionExecutorDeps['homeDomainAction']>;
type TeamCredentialUsageExportAction = NonNullable<ActionExecutorDeps['teamCredentialUsageExport']>;

const TEAM_RESOURCE_LABEL_READ_POLICY = { kind: 'team-resource' } as const;

/**
 * Headless CLI keeps the same admitted Home read and captured Account key that
 * its Action factory already owns. A connected UI remains a fallback only for
 * hosts without this local keyholder.
 */
export function createCliTeamCredentialUsageExportAction(params: Readonly<{
  credentials: StoredCredentials;
  homeDomainAction: HomeDomainAction;
}>): TeamCredentialUsageExportAction {
  return async ({ input, context, signal }) => {
    const actionSignal = signal ?? context.signal;
    const accountKey = deriveCliPrivateLabelAccountKey(params.credentials.encryption);
    try {
      return await buildTeamCredentialUsageExportFromRecipientProjectionV1({
        input,
        ...(actionSignal ? { signal: actionSignal } : {}),
        readPage: async query => {
          actionSignal?.throwIfAborted();
          const raw = await params.homeDomainAction({
            actionId: 'teams.credentials.usage.query',
            input: query,
            context,
            ...(actionSignal ? { signal: actionSignal } : {}),
          });
          actionSignal?.throwIfAborted();
          const failure = readActionFailureEnvelope(raw);
          if (failure) return failure;
          const page = TeamCredentialUsageQueryResultV1Schema.safeParse(raw);
          return page.success
            ? page.data
            : { ok: false as const, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
        },
        openLabel: async ({ binding, label }) => openCliPrivateLabel({
          binding,
          label,
          readPolicy: TEAM_RESOURCE_LABEL_READ_POLICY,
          ...(accountKey ? { accountKey } : {}),
        }),
      });
    } finally {
      accountKey?.fill(0);
    }
  };
}
