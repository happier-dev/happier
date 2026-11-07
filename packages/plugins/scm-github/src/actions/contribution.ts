import type { JsonValue } from '@happier-dev/plugin-sdk';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { ActionConfirmationInputField, PluginActionReadObserver } from '@happier-dev/plugin-sdk/actions';
import { ForgeCiActionInputSchemasV1, ForgeCiActionResultSchemasV1, type ForgeCiOperationIdV1 } from './contracts.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../observations/githubProviderContracts.js';
import { GITHUB_CI_ACTION_IDS_V1 } from './actionIds.js';
import type { GithubCiInvocationContextV1 } from './operations.js';

export { GITHUB_CI_ACTION_IDS_V1 } from './actionIds.js';

export function binding<K extends ForgeCiOperationIdV1>(operation: K, title: string, description: string,
  dangerLevel: 'safe' | 'writesRemote' | 'destructive' | 'writesLocal' = 'safe', confirmation?: Readonly<{ title: string; body: string; confirmLabel: string; inputFields?: readonly ActionConfirmationInputField[] }>) {
  const download = operation === 'downloadArtifact' || operation === 'downloadJobLog';
  const media = download || operation === 'readJobLog' || operation === 'readFailureContext';
  const selectsCredential = ForgeCiActionInputSchemasV1[operation].jsonSchema.properties?.credentialRef !== undefined;
  return {
    title, description, surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'] as const, placementBindings: [], dangerLevel,
    ...(download ? { operation: { version: 1 as const, visibility: 'activity' as const, progress: 'indeterminate' as const,
      presentation: { onStart: 'activity' as const } } } : {}),
    ...(dangerLevel === 'safe' ? { readOnly: true as const } : {}),
    ...(operation === 'listRuns' ? { observeRead: ((_input, invalidate, context) =>
      context.services.connectedAccounts.watch(GITHUB_CONNECTED_ACCOUNT_PURPOSE, invalidate)) satisfies PluginActionReadObserver } : {}),
    ...(dangerLevel === 'safe' || confirmation !== undefined ? {} : { confirmationWhen: { presentUserUi: false as const } }),
    ...(dangerLevel === 'safe' ? {} : { confirmation: confirmation ?? { title, body: description, confirmLabel: title } }),
    inputSchema: ForgeCiActionInputSchemasV1[operation].jsonSchema,
    ...(selectsCredential ? { connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE }] } : {}),
    resultSchema: ForgeCiActionResultSchemasV1[operation].jsonSchema,
    hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE, ...(media ? ['github-downloads'] : [])],
    run: async (input: JsonValue, context: GithubCiInvocationContextV1<K>) => {
      const result = await (await import('./operations.js')).executeGithubCiAction(operation, input, context);
      return projectNativeJsonValueForTransport(ForgeCiActionResultSchemasV1[operation].parse(result));
    },
  };
}

export const GITHUB_CI_ACTION_BINDINGS_V1 = {
  [GITHUB_CI_ACTION_IDS_V1.listWorkflows]: binding('listWorkflows', 'Read GitHub workflows', 'Reads one requested workflow metadata page without fetching YAML.'),
  [GITHUB_CI_ACTION_IDS_V1.readWorkflow]: binding('readWorkflow', 'Read a GitHub workflow', 'Reads exact workflow metadata; selected-ref inputs use the trigger Action.'),
  [GITHUB_CI_ACTION_IDS_V1.listRuns]: binding('listRuns', 'Read GitHub workflow runs', 'Reads one filtered page of runs, newest first, with explicit coverage: `pageSize` runs'
    + ' (1–100, default 100). Pass the returned `continuation` back as `cursor`, with the same `pageSize`, for the next page.'),
  [GITHUB_CI_ACTION_IDS_V1.readRun]: binding('readRun', 'Read a GitHub workflow run', 'Reads an exact run or attempt without acquiring YAML, logs or annotations.'),
  [GITHUB_CI_ACTION_IDS_V1.listJobs]: binding('listJobs', 'Read GitHub run jobs', 'Reads the selected attempt jobs and steps together without per-job fanout.'),
  [GITHUB_CI_ACTION_IDS_V1.readJob]: binding('readJob', 'Read a GitHub job', 'Looks up an exact native job ID and returns its actual run and attempt provenance.'),
  [GITHUB_CI_ACTION_IDS_V1.readJobLog]: binding('readJobLog', 'Read a completed GitHub job log', 'Reads only the selected completed job; active jobs return pending without log I/O.'),
  [GITHUB_CI_ACTION_IDS_V1.listArtifacts]: binding('listArtifacts', 'Read GitHub run artifacts', 'Reads run-scoped artifact metadata, including expiry; no archive prefetch.'),
  [GITHUB_CI_ACTION_IDS_V1.listAnnotations]: binding('listAnnotations', 'Read GitHub job annotations', 'Reads one requested annotations page after verifying the selected job and Check Run relation.'),
  [GITHUB_CI_ACTION_IDS_V1.readTrigger]: binding('readTrigger', 'Read GitHub workflow inputs', 'Reads the actual selected-ref workflow definition through the immutable commit-SHA owner.'),
  [GITHUB_CI_ACTION_IDS_V1.listEnvironments]: binding('listEnvironments', 'Read GitHub environments', 'Reads one requested environment-options page.'),
  [GITHUB_CI_ACTION_IDS_V1.downloadArtifact]: binding('downloadArtifact', 'Download a GitHub artifact', 'Delivers one exact private artifact through the canonical file transfer and destination approval.', 'writesLocal'),
  [GITHUB_CI_ACTION_IDS_V1.downloadJobLog]: binding('downloadJobLog', 'Download a GitHub job log', 'Delivers one exact completed job log through the canonical file transfer and destination approval.', 'writesLocal'),
  [GITHUB_CI_ACTION_IDS_V1.dispatchWorkflow]: binding('dispatchWorkflow', 'Run a GitHub workflow', 'Validates current selected-ref inputs and dispatches once, returning only the exact native run receipt.', 'writesRemote'),
  [GITHUB_CI_ACTION_IDS_V1.enableWorkflow]: binding('enableWorkflow', 'Enable a GitHub workflow', 'Enables this exact workflow on GitHub.', 'writesRemote'),
  [GITHUB_CI_ACTION_IDS_V1.disableWorkflow]: binding('disableWorkflow', 'Disable a GitHub workflow', 'Disables this exact workflow on GitHub.', 'writesRemote'),
  [GITHUB_CI_ACTION_IDS_V1.rerunAll]: binding('rerunAll', 'Re-run all jobs', 'Re-runs the exact current run at its original commit and settings.', 'writesRemote'),
  [GITHUB_CI_ACTION_IDS_V1.rerunFailed]: binding('rerunFailed', 'Re-run failed jobs', 'Re-runs failed jobs and their dependent jobs at the original commit.', 'writesRemote'),
  [GITHUB_CI_ACTION_IDS_V1.rerunJob]: binding('rerunJob', 'Re-run this job', 'GitHub also re-runs jobs that depend on this job, at the original commit.', 'writesRemote'),
  [GITHUB_CI_ACTION_IDS_V1.cancelRun]: binding('cancelRun', 'Cancel run', 'Requests ordinary cancellation of this exact run; acceptance is not proof it has stopped.', 'writesRemote'),
  [GITHUB_CI_ACTION_IDS_V1.forceCancelRun]: binding('forceCancelRun', 'Force-cancel run', 'Force-cancels this exact run without automatic escalation from ordinary cancellation.', 'destructive', {
    title: 'Force-cancel this run?', body: 'This skips if: always() cleanup and can leave external resources unresolved. Re-running cannot undo skipped cleanup.', confirmLabel: 'Force-cancel',
  }),
  [GITHUB_CI_ACTION_IDS_V1.approveForkRun]: binding('approveForkRun', 'Approve fork run', 'Runs untrusted fork code from the contributor and commit shown in this exact run. Fresh provider facts must confirm it is awaiting approval.', 'writesRemote', {
    title: 'Approve this fork run?', body: 'This executes untrusted code from the contributor at the commit shown for this exact run. Review both before approving.', confirmLabel: 'Approve fork run',
    inputFields: [
      { path: 'repository.repository', title: 'Repository' },
      { path: 'runId', title: 'Run' },
      { path: 'attempt', title: 'Attempt' },
      { path: 'contributor', title: 'Contributor' },
      { path: 'headSha', title: 'Commit' },
      { path: 'sourceRepository.deployment', title: 'Source deployment' },
      { path: 'sourceRepository.repository', title: 'Source repository' },
    ],
  }),
  [GITHUB_CI_ACTION_IDS_V1.readFailureContext]: binding('readFailureContext', 'Read GitHub failure evidence', 'Returns typed selected-job evidence for the shared configured handoff. It cannot send to or start a Session.'),
};
