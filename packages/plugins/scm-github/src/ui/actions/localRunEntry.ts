import { LocalActRunSeedV1Schema, type LocalActRunSeedV1, type LocalActRunFormInput } from '../../actions/local/contracts.js';
import type { GithubWorkflowDefinitionV1 } from '../../actions/workflowDefinition.js';

/** Captured current-context command data only. Resolving the accepted checkout
 * precedes this function; explicit open starts L08's finite inspection, not a process. */
export function githubLocalRunOpenIntentV1(input: Readonly<{
  target: Extract<LocalActRunSeedV1['target'], { kind: 'project' }>;
  workspace: LocalActRunSeedV1['workspace']; workflowPath?: string; sourceHeadSha?: string;
  definition?: GithubWorkflowDefinitionV1; yamlJobId?: string; event?: string;
}>): Extract<LocalActRunFormInput, { operation: { kind: 'open' } }> {
  const knownJob = input.yamlJobId !== undefined && input.definition?.jobs.some(job => job.id === input.yamlJobId);
  const knownEvent = input.event !== undefined && input.definition?.triggers.includes(input.event);
  const seed = LocalActRunSeedV1Schema.parse({ target: input.target, workspace: input.workspace,
    ...(input.workflowPath === undefined ? {} : { workflowPath: input.workflowPath }),
    ...(input.sourceHeadSha === undefined ? {} : { sourceHeadSha: input.sourceHeadSha }),
    ...(knownJob ? { yamlJobId: input.yamlJobId } : {}), ...(knownEvent ? { event: input.event } : {}) });
  return { operation: { kind: 'open', seed } };
}
