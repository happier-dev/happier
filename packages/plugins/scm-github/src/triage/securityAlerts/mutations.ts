import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { settleAtMostOnceProviderWrite } from '@happier-dev/triage-sources/runtime';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { admitGithubDetailInvocation } from '../admission.js';
import { classifyGithubResponseFailure, classifyGithubTransportFailure, GITHUB_ROUTE_BODY_MISMATCH_FAILURE, isGithubSuccessStatus, isGithubWriteResponseAmbiguous } from '../errors.js';
import { buildGithubCollisionScope } from '../identity.js';
import { toTriageObservation } from '../mapping/protocol.js';
import { createGithubRepositoryReader } from '../repositories.js';
import {
  GithubDependabotDismissInputV1Schema, GithubDependabotReopenInputV1Schema, GithubCodeScanningDismissInputV1Schema, GithubCodeScanningReopenInputV1Schema,
  type GithubSecurityAlertMutationResultV1,
} from './actionContracts.js';
import { buildGithubSecurityAlertUrl, GITHUB_SECURITY_ALERT_INPUT_FAILURE, readAdmittedGithubSecurityAlert, readGithubNativeSecurityAlert } from './reads.js';

type MutationRequest = ReturnType<typeof GithubDependabotDismissInputV1Schema.parse> | ReturnType<typeof GithubDependabotReopenInputV1Schema.parse> | ReturnType<typeof GithubCodeScanningDismissInputV1Schema.parse> | ReturnType<typeof GithubCodeScanningReopenInputV1Schema.parse>;
type Dispatch = Readonly<{ kind: 'accepted' }> | Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1; mayHaveChanged: boolean }>;
function failed(failure: TriageSourceFailureV1): GithubSecurityAlertMutationResultV1 { return { kind: 'failed', failure }; }

/** One native state owner for both families; reasons are admitted by distinct Action schemas. */
async function transitionGithubSecurityAlert(request: MutationRequest, targetState: 'open' | 'dismissed', context: PluginInvocationContext): Promise<GithubSecurityAlertMutationResultV1> {
  const kindId = request.localRef.kindId;
  const admitted = await admitGithubDetailInvocation({ ...request, admissibleKinds: [kindId] }, context);
  if (!admitted.ok) return failed(admitted.failure);
  const before = await readAdmittedGithubSecurityAlert(admitted);
  if (before.kind === 'unavailable') return failed(before.failure);
  const observation = toTriageObservation(before.observation);
  if (before.alert.state === targetState) return { kind: 'applied', effect: 'alreadySatisfied', observation };
  if (before.alert.state === 'fixed') return { kind: 'refused', reason: targetState === 'open' ? 'state_not_reopenable' : 'state_not_dismissible', observation };
  const reopenable = before.alert.state === 'dismissed' || kindId === 'dependabot-alert' && before.alert.state === 'auto_dismissed';
  if (targetState === 'open' ? !reopenable : before.alert.state !== 'open') return { kind: 'refused', reason: 'state_changed', observation };

  let pending = false;
  const settlement = await settleAtMostOnceProviderWrite({
    dispatch: async (): Promise<Dispatch> => {
      try {
        const response = await admitted.client.request({
          url: buildGithubSecurityAlertUrl({ kindId, route: admitted.route, entryNumber: admitted.entryNumber }), method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify({ state: targetState, ...('reason' in request ? { dismissed_reason: request.reason, ...('comment' in request && request.comment !== undefined ? { dismissed_comment: request.comment } : {}) } : {}) })),
        });
        pending = response.status === 202;
        return isGithubSuccessStatus(response.status) ? { kind: 'accepted' } : { kind: 'failed', failure: classifyGithubResponseFailure(response, Date.now()), mayHaveChanged: isGithubWriteResponseAmbiguous(response) };
      } catch (error) { return { kind: 'failed', failure: classifyGithubTransportFailure(error), mayHaveChanged: true }; }
    },
    mayHaveChanged: result => result.kind === 'accepted' || result.mayHaveChanged,
    confirm: async () => {
      // Alert bodies omit repository identity: settlement proves it afresh too.
      const repository = await createGithubRepositoryReader({ client: admitted.client, now: Date.now }).read(admitted.route);
      if (repository.kind !== 'readable') return { kind: 'uncertain' as const, failure: repository.failure };
      if (buildGithubCollisionScope(repository.repositoryId) !== admitted.localRef.collisionScope) return { kind: 'uncertain' as const, failure: GITHUB_ROUTE_BODY_MISMATCH_FAILURE };
      const after = await readGithubNativeSecurityAlert({ localRef: admitted.localRef, route: admitted.route, repositoryId: repository.repositoryId, repositoryKey: repository.repositoryKey ?? `${admitted.route.owner}/${admitted.route.name}` }, { client: admitted.client, now: Date.now });
      if (after.kind === 'unavailable') return { kind: 'uncertain' as const, failure: after.failure };
      const confirmed = toTriageObservation(after.observation);
      if (after.alert.state === targetState) return { kind: 'applied' as const, observation: confirmed };
      if (after.alert.state === before.alert.state) return { kind: 'unchanged' as const, observation: confirmed };
      return { kind: 'uncertain' as const, observation: confirmed };
    },
  });
  if (settlement.kind === 'settled') return settlement.result.kind === 'failed' ? failed(settlement.result.failure) : { kind: 'uncertain' };
  if (settlement.kind === 'applied') return { kind: 'applied', effect: 'changed', observation: settlement.observation };
  if (settlement.kind === 'unchanged') return { kind: 'refused', reason: pending && targetState === 'dismissed' ? 'dismissal_pending' : 'state_unchanged', observation: settlement.observation };
  return settlement;
}

export async function dismissGithubDependabotAlert(input: unknown, context: PluginInvocationContext): Promise<GithubSecurityAlertMutationResultV1> {
  const parsed = GithubDependabotDismissInputV1Schema.safeParse(input);
  return parsed.success ? transitionGithubSecurityAlert(parsed.data, 'dismissed', context) : failed(GITHUB_SECURITY_ALERT_INPUT_FAILURE);
}
export async function reopenGithubDependabotAlert(input: unknown, context: PluginInvocationContext): Promise<GithubSecurityAlertMutationResultV1> {
  const parsed = GithubDependabotReopenInputV1Schema.safeParse(input);
  return parsed.success ? transitionGithubSecurityAlert(parsed.data, 'open', context) : failed(GITHUB_SECURITY_ALERT_INPUT_FAILURE);
}
export async function dismissGithubCodeScanningAlert(input: unknown, context: PluginInvocationContext): Promise<GithubSecurityAlertMutationResultV1> {
  const parsed = GithubCodeScanningDismissInputV1Schema.safeParse(input);
  return parsed.success ? transitionGithubSecurityAlert(parsed.data, 'dismissed', context) : failed(GITHUB_SECURITY_ALERT_INPUT_FAILURE);
}
export async function reopenGithubCodeScanningAlert(input: unknown, context: PluginInvocationContext): Promise<GithubSecurityAlertMutationResultV1> {
  const parsed = GithubCodeScanningReopenInputV1Schema.safeParse(input);
  return parsed.success ? transitionGithubSecurityAlert(parsed.data, 'open', context) : failed(GITHUB_SECURITY_ALERT_INPUT_FAILURE);
}
