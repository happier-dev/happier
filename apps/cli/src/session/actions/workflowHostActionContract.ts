import { randomUUID } from 'node:crypto';
import type { ActionExecuteResult } from '@happier-dev/protocol';
import { freezeWorkflowActionContractV1, readCompleteActionSpecV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';

import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { CliActionDepsParams } from './cliActionDeps/types';
import type { WorkflowMaterializationHostDeps } from './workflowMaterializationHost';

type ReadHostActionContract = NonNullable<WorkflowMaterializationHostDeps['readHostActionContract']>;
export type ReadLocalWorkflowActionSpec = (
  input: Parameters<Parameters<typeof readCompleteActionSpecV1>[0]['read']>[0],
  target: Parameters<ReadHostActionContract>[1],
) => Promise<ActionExecuteResult | null>;

/** Native contracts come from the exact installed host, using Home for remote delivery. */
export function createWorkflowHostActionContractReader(
  params: CliActionDepsParams & { credentials: NonNullable<CliActionDepsParams['credentials']> },
  readLocalActionSpec: ReadLocalWorkflowActionSpec,
): ReadHostActionContract {
  const serverHttpBaseUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  return async (actionId, target) => {
    const disabledContract = new Error('action_disabled');
    try {
      const action = await readCompleteActionSpecV1({ actionId, ...(target.signal ? { signal: target.signal } : {}),
        read: async input => {
          const result = await readLocalActionSpec(input, target) ?? await dispatchOriginalAccountAction({
            actionId: 'action.spec.get', input, requestId: randomUUID(), credentials: params.credentials,
            serverHttpBaseUrl, serverIdentityId: params.serverIdentityId, authority: 'account_automation',
            target: { kind: 'machine', machineId: target.machineId,
              project: { machineId: target.machineId, directory: target.directory } },
            ...(params.isCredentialCurrent ? { isCurrent: params.isCredentialCurrent } : {}),
            ...(params.onRequesterSessionCredentialDisclosure
              ? { onRequesterSessionCredentialDisclosure: params.onRequesterSessionCredentialDisclosure } : {}),
            ...(target.signal ? { signal: target.signal } : {}),
          });
          if (!result.ok) {
            // The host already decided availability; absence is the materializer's
            // typed unavailable contract, while all other failures still propagate.
            if (result.errorCode === 'action_disabled') throw disabledContract;
            throw createActionExecuteFailureError(result);
          }
          return result.result;
        },
      });
      return freezeWorkflowActionContractV1(action);
    } catch (error) {
      target.signal?.throwIfAborted();
      if (error === disabledContract) return null;
      throw error;
    }
  };
}
