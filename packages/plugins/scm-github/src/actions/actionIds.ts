import type { ForgeCiOperationIdV1 } from './contracts.js';

/** Browser-safe references shared by native declarations and declarative UI controls. */
export const GITHUB_CI_ACTION_IDS_V1 = Object.freeze({
  listWorkflows: 'github/actions/workflows-list', readWorkflow: 'github/actions/workflow-read', listRuns: 'github/actions/runs-list', readRun: 'github/actions/run-read',
  listJobs: 'github/actions/jobs-list', readJob: 'github/actions/job-read', readJobLog: 'github/actions/job-log-read', listArtifacts: 'github/actions/artifacts-list',
  downloadArtifact: 'github/actions/artifact-download', listAnnotations: 'github/actions/annotations-list', readTrigger: 'github/actions/trigger-read', listEnvironments: 'github/actions/environments-list',
  downloadJobLog: 'github/actions/job-log-download', dispatchWorkflow: 'github/actions/workflow-dispatch', enableWorkflow: 'github/actions/workflow-enable', disableWorkflow: 'github/actions/workflow-disable',
  rerunAll: 'github/actions/run-rerun-all', rerunFailed: 'github/actions/run-rerun-failed', rerunJob: 'github/actions/job-rerun', cancelRun: 'github/actions/run-cancel',
  forceCancelRun: 'github/actions/run-force-cancel', approveForkRun: 'github/actions/fork-run-approve', listDeployments: 'github/actions/deployments-list',
  readDeploymentHistory: 'github/actions/deployment-history-read', approveDeployment: 'github/actions/deployment-approve', rejectDeployment: 'github/actions/deployment-reject', readFailureContext: 'github/actions/failure-context-read',
} satisfies Record<ForgeCiOperationIdV1, string>);
export const GITHUB_PROJECT_READINESS_ACTION_ID_V1 = 'github/actions/project-readiness-read';
