import * as React from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { useExecutePluginAction, type PluginActionExecution } from '@happier-dev/plugin-ui';
import { LOCAL_ACT_ACTION_IDS } from '../../../actions/local/contracts.js';
import { GITHUB_PLUGIN_ID } from '../../../observations/githubProviderContracts.js';
import { githubLocalRunOpenIntentV1 } from '../../actions/localRunEntry.js';

const LOCAL_FORM = {
  pluginId: GITHUB_PLUGIN_ID,
  localId: LOCAL_ACT_ACTION_IDS.form,
} as const;

export type GithubLocalRunOpenV1 = (
  facts: Readonly<{ workflowPath?: string; sourceHeadSha?: string }>,
) => Promise<PluginActionExecution<JsonValue>>;

/**
 * Open 08's one local-run form for this Project's accepted checkout, seeded with admitted workflow facts only
 * (D-I13: the Project target travels in the seed). `null` without an accepted checkout: the entry is not drawn.
 * Opening reads nothing hosted and starts no process; the form owns inspection and Run.
 */
export function useGithubLocalRunOpenV1(
  context: RenderContext,
): GithubLocalRunOpenV1 | null {
  const { execute } = useExecutePluginAction(LOCAL_FORM);
  const target = context.surface.target;
  const checkout = target.kind === 'project' ? target.checkout : undefined;
  const projectId = target.kind === 'project' ? target.projectKey : null;
  return React.useMemo(() => {
    if (checkout === undefined || projectId === null) return null;
    const workspace = {
      serverId: checkout.serverId,
      workspaceId: checkout.id,
      machineId: checkout.machineId,
      rootPath: checkout.rootPath,
    };
    return (facts) => {
      const intent = githubLocalRunOpenIntentV1({
        target: { kind: 'project', projectId },
        workspace,
        ...(facts.workflowPath === undefined
          ? {}
          : { workflowPath: facts.workflowPath }),
        ...(facts.sourceHeadSha === undefined
          ? {}
          : { sourceHeadSha: facts.sourceHeadSha }),
      });
      return execute(intent);
    };
  }, [execute, checkout, projectId]);
}
