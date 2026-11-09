import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { ForgeCiOperationIdV1 } from '@happier-dev/triage-protocol/ci/v1';
import { GITHUB_CI_ACTION_IDS_V1 } from '../../actions/actionIds.js';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';

export const GITHUB_CI_ACTION_REFS_V1 = Object.freeze(Object.fromEntries(Object.entries(GITHUB_CI_ACTION_IDS_V1)
  .map(([operation, localId]) => [operation, { pluginId: GITHUB_PLUGIN_ID, localId }]))) as Readonly<Record<ForgeCiOperationIdV1, PluginContributionRef>>;

export type GithubActionsLocationV1 = Readonly<{ kind: 'list'; view: 'runs' | 'workflows' }>
  | Readonly<{ kind: 'workflow'; workflowId: string; presentation: 'pane' | 'page' }>
  | Readonly<{ kind: 'run'; runId: string; attempt: string; jobId?: string; presentation: 'pane' | 'page' }>;
export function parseGithubActionsLocationV1(value: string): GithubActionsLocationV1 | null {
  if (value === '' || value === 'runs' || value === 'workflows') return { kind: 'list', view: value === 'workflows' ? 'workflows' : 'runs' };
  const workflow = /^workflows\/([1-9][0-9]*)(\/page)?$/u.exec(value);
  if (workflow) return { kind: 'workflow', workflowId: workflow[1]!, presentation: workflow[2] === undefined ? 'pane' : 'page' };
  const run = /^runs\/([1-9][0-9]*)\/attempts\/([1-9][0-9]*)(?:\/jobs\/([1-9][0-9]*))?(\/page)?$/u.exec(value);
  return run ? { kind: 'run', runId: run[1]!, attempt: run[2]!, ...(run[3] === undefined ? {} : { jobId: run[3] }), presentation: run[4] === undefined ? 'pane' : 'page' } : null;
}
export function githubActionsPaneLocationsV1(subPath: string) {
  const location = parseGithubActionsLocationV1(subPath);
  if (location === null || location.kind === 'list') return null;
  const detail = location.kind === 'workflow' ? `workflows/${location.workflowId}`
    : `runs/${location.runId}/attempts/${location.attempt}${location.jobId === undefined ? '' : `/jobs/${location.jobId}`}`;
  return { fullPageLocation: { subPath: `${detail}/page`, backLocation: detail }, returnLocation: { subPath: detail, backLocation: location.kind === 'workflow' ? 'workflows' : 'runs' } };
}
/** No local expanded mode: the host's returned settled domain path is authoritative. */
export async function replaceGithubActionsLocationV1(host: Readonly<{ replacePageLocation(subPath: string, options: Readonly<{ backLocation: string }>): Promise<Readonly<{ subPath: string }>> }>,
  target: Readonly<{ subPath: string; backLocation: string }>, previous: GithubActionsLocationV1) {
  try {
    const settled = await host.replacePageLocation(target.subPath, { backLocation: target.backLocation });
    const location = parseGithubActionsLocationV1(settled.subPath);
    if (location !== null) return { kind: 'applied' as const, location };
  } catch { /* The prior admitted body remains available on a refused transition. */ }
  return { kind: 'unavailable' as const, location: previous };
}
