import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ProtocolComposableSchema } from '@happier-dev/plugin-sdk/protocol';
import { settleAtMostOnceProviderWrite } from '@happier-dev/triage-sources/runtime';
import { admitGithubEntryInvocation } from '../admission.js';
import { classifyGithubResponseFailure, isGithubSuccessStatus, isGithubWriteResponseAmbiguous } from '../errors.js';
import { readGithubEntryMetadata, type GithubIssueFactsV1 } from '../get.js';
import { buildGithubApiUrl } from '../locator.js';
import { toTriageFailure } from '../mapping/protocol.js';
import { createGithubRepositoryReader } from '../repositories.js';
import {
  GithubEntryMilestoneSetInputV1Schema, GithubIssueTypeSetInputV1Schema,
  GithubEntryLockInputV1Schema, GithubEntryUnlockInputV1Schema,
  type GithubIssueDeltaResultV1,
} from './contracts.js';
import { reduceGithubEntryMutationRead, sendGithubEntryMutation } from './issue.js';

type Target = ReturnType<typeof GithubEntryUnlockInputV1Schema.parse>;
type Change = Readonly<{ kind: 'milestone'; value: number | null }>
  | Readonly<{ kind: 'type'; value: string | null }>
  | Readonly<{ kind: 'lock'; reason?: ReturnType<typeof GithubEntryLockInputV1Schema.parse>['reason'] }>
  | Readonly<{ kind: 'unlock' }>;

/** Exact Actions share admission and settlement; no UI/agent-specific write path. */
async function invoke<T extends Target>(schema: ProtocolComposableSchema<T>, input: unknown,
  context: PluginInvocationContext, changeFor: (request: T) => Change): Promise<GithubIssueDeltaResultV1> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { kind: 'failed', failure: { class: 'unsupportedContract', code: 'github_mutation_input_invalid' } };
  const change = changeFor(parsed.data);
  const admitted = await admitGithubEntryInvocation({ ...parsed.data,
    admissibleKinds: change.kind === 'type' ? ['issue'] : ['issue', 'pull-request'] }, context);
  if (!admitted.ok) return { kind: 'failed', failure: admitted.failure };
  const dependencies = { client: admitted.client, now: Date.now, signal: admitted.signal };
  const repositories = createGithubRepositoryReader(dependencies);
  const read = async () => reduceGithubEntryMutationRead(
    await readGithubEntryMetadata(admitted.localRef, admitted.route, repositories, dependencies),
  );
  const matches = (facts: GithubIssueFactsV1) => {
    switch (change.kind) {
      case 'milestone': return facts.milestoneNumber === change.value;
      case 'type': return facts.issueType === change.value;
      case 'lock': return facts.locked === true && (change.reason === undefined || facts.lockReason === change.reason);
      case 'unlock': return facts.locked === false;
    }
  };
  const current = await read();
  if (!current.ok) return { kind: 'failed', failure: current.failure };
  if (matches(current.facts)) return { kind: 'applied', effect: 'alreadySatisfied', observation: current.observation };
  const path = ['repos', admitted.route.owner, admitted.route.name, 'issues', admitted.entryNumber];
  const request = change.kind === 'lock'
    ? { method: 'PUT' as const, url: buildGithubApiUrl([...path, 'lock']), body: change.reason === undefined ? {} : { lock_reason: change.reason } }
    : change.kind === 'unlock' ? { method: 'DELETE' as const, url: buildGithubApiUrl([...path, 'lock']) }
      : { method: 'PATCH' as const, url: buildGithubApiUrl(path),
        body: change.kind === 'milestone' ? { milestone: change.value } : { type: change.value } };
  const result = await settleAtMostOnceProviderWrite({
    dispatch: () => sendGithubEntryMutation(dependencies, request),
    mayHaveChanged: response => !response.ok || isGithubSuccessStatus(response.response.status) || isGithubWriteResponseAmbiguous(response.response),
    confirm: async () => {
      const observed = await read();
      if (!observed.ok) return { kind: 'uncertain' as const, failure: observed.failure };
      return matches(observed.facts)
        ? { kind: 'applied' as const, observation: observed.observation }
        : { kind: 'uncertain' as const, observation: observed.observation };
    },
  });
  if (result.kind === 'applied') return { ...result, effect: 'changed' };
  if (result.kind === 'unchanged') return { kind: 'uncertain', observation: result.observation };
  if (result.kind === 'uncertain') return result;
  return { kind: 'failed', failure: result.result.ok
    ? toTriageFailure(classifyGithubResponseFailure(result.result.response, dependencies.now())) : result.result.failure };
}

export const setGithubEntryMilestoneAction = (input: unknown, context: PluginInvocationContext): Promise<GithubIssueDeltaResultV1> =>
  invoke(GithubEntryMilestoneSetInputV1Schema, input, context, request => ({ kind: 'milestone', value: request.milestone }));
export const setGithubIssueTypeAction = (input: unknown, context: PluginInvocationContext): Promise<GithubIssueDeltaResultV1> =>
  invoke(GithubIssueTypeSetInputV1Schema, input, context, request => ({ kind: 'type', value: request.issueType }));
export const lockGithubEntryAction = (input: unknown, context: PluginInvocationContext): Promise<GithubIssueDeltaResultV1> =>
  invoke(GithubEntryLockInputV1Schema, input, context, request => ({ kind: 'lock', ...(request.reason === undefined ? {} : { reason: request.reason }) }));
export const unlockGithubEntryAction = (input: unknown, context: PluginInvocationContext): Promise<GithubIssueDeltaResultV1> =>
  invoke(GithubEntryUnlockInputV1Schema, input, context, () => ({ kind: 'unlock' }));
