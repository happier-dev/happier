import type { StoredCredentials } from '@/persistence';
import type { TargetActionCurrentIntentRequest, TargetActionCurrentIntentResult } from '@/plugins/runtime/invocation/actionExecutor';
import { observeAccountChanges } from '@/api/observeAccountChanges';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliApprovalsArtifactStore } from './artifactStore';
import { createTargetActionCurrentIntentAdapter } from './targetActionCurrentIntent';
import { logger } from '@/ui/logger';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { PUBLIC_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { createTargetActionApprovalDecision } from '@happier-dev/protocol/actions/targetActionApprovalDecision';
import { createLiveCliApprovalOrigin } from './liveOrigin';

/** Bind the incumbent target-Action approval owner to this Home's Account material. */
export function createCredentialedTargetActionCurrentIntent(
  credentials: StoredCredentials,
): (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult> {
  const store = createCliApprovalsArtifactStore({ credentials });
  return async currentIntent => {
    const serverUrl = resolveServerHttpBaseUrl();
    const reportUnavailable: NonNullable<typeof currentIntent.reportUnavailable> = currentIntent.reportUnavailable
      ?? (reason => logger.debug('[RPC] Target Action current intent unavailable', {
        code: 'plugin_action_current_intent_unavailable', reason,
      }));
    const accountId = readAccountIdFromToken(credentials.token);
    const origin = currentIntent.executionOriginV1;
    // The credentialed publisher owns this Account fact. A contextual Machine
    // does not turn a standalone CLI's private operands into daemon custody.
    const intent = origin?.surface === 'cli' && origin.caller.kind === 'host'
      && !origin.externalActionExecutionAuthorization && origin.accountId === undefined && accountId
      ? { ...currentIntent, executionOriginV1: { ...origin, accountId } } : currentIntent;
    const read = async (artifactId: string) => liveOrigin.validateRead(artifactId,
      await runWithServerHttpBaseUrl(serverUrl, () => store.targetActionApprovalsGet({ artifactId })));
    const update: typeof store.targetActionApprovalsUpdate = args =>
      runWithServerHttpBaseUrl(serverUrl, () => store.targetActionApprovalsUpdate(args));
    const decide = createTargetActionApprovalDecision({ read, update });
    const liveOrigin = createLiveCliApprovalOrigin({ token: credentials.token, accountId, serverUrl,
      decide: async (input, context) => {
        const parsed = PUBLIC_ACTION_INPUT_SCHEMAS['approval.request.decide'].parse(input);
        return await decide({ ...parsed, context })
          ?? { ok: false, errorCode: 'approval_not_found', error: 'approval_not_found' };
      },
    });
    const execute = () => runWithServerHttpBaseUrl(serverUrl, () => createTargetActionCurrentIntentAdapter({
      create: async (request, onReady) => {
        const created = await liveOrigin.publish({ request }, () => store.targetActionApprovalsCreate({ request, onReady }));
        liveOrigin.waiterReady(created.artifactId);
        return created;
      },
      read,
      update,
      subscribeChanges: (artifactId, onChange, onError) => observeAccountChanges({
        token: credentials.token,
        serverUrl,
        entityId: artifactId,
      }, { onChange, onError }),
    })({ ...intent, reportUnavailable }));
    // Publication consumes resolveApprovalExecutor through the existing origin
    // publisher; this adapter does not decide which host owns live custody.
    return await liveOrigin.run({ surface: intent.executionOriginV1?.surface ?? 'cli',
      authority: intent.executionOriginV1?.authority, actionCaller: intent.executionOriginV1?.caller,
      ...(intent.signal ? { signal: intent.signal } : {}) }, execute);
  };
}
