import type {
  WorkflowWorkspaceCreationIntentV1,
  WorkflowWorkspaceDescriptorV1,
} from '@happier-dev/protocol';

import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { runWithRealGitScmRuntime } from '../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createScmBackendRegistry } from '@/scm/registry';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';
import { realizeWorkspaceCheckoutWithScmWorkspaceSource } from '@/scm/workspace/workspaceCheckoutOperations';
import { resolveDirectoryInCheckout } from '@/workspaces/activation/resolveDirectoryInCheckout';

import { verifyWorkflowWorkspaceCurrentness } from './resolveWorkflowWorkspace';

/** Real Git/SCM boundary fixture; production still acquires the daemon-applied plugin registry. */
export function createGitWorkflowWorkspaceTestDependencies() {
  const registration = createGitScmBackendRuntimeRegistration();
  if (!registration.runtime) throw new Error('Git SCM test runtime is unavailable');
  const backend = createRegisteredScmBackendAdapter({
    definition: { id: 'git', kind: 'git' },
    qualifiedId: 'happier.scm.git/git',
    executableDefinition: registration.runtime,
    registration,
  });
  const registry = createScmBackendRegistry([backend]);
  const inspectLocation = async (input: Readonly<{ candidatePath: string }>) => (
    await runWithRealGitScmRuntime(async () => (
      await inspectWorkspaceLocationWithScmWorkspace({ ...input, registry })
    ))
  );

  return {
    inspectLocation,
    inspectCommittedRevision: async (directory: string) => (
      (await inspectLocation({ candidatePath: directory }))?.inspection.committedRevision ?? null
    ),
    realizeWorktree: async (intent: WorkflowWorkspaceCreationIntentV1) => {
      const realized = await runWithRealGitScmRuntime(async () => (
        await realizeWorkspaceCheckoutWithScmWorkspaceSource({
          sourcePath: intent.sourceDirectory,
          checkoutCreation: intent,
          registry,
        })
      ));
      return realized ? {
        directory: await resolveDirectoryInCheckout({
          sourceDirectory: intent.sourceDirectory,
          sourceRootPath: realized.sourceRootPath,
          checkoutRootPath: realized.realization.targetPath,
        }),
        checkoutRootPath: realized.realization.targetPath,
        branchName: realized.realization.branchName,
      } : null;
    },
    verifyRecordedWorkspace: async (
      workspace: WorkflowWorkspaceDescriptorV1,
      creationIntent?: WorkflowWorkspaceCreationIntentV1,
    ) => await verifyWorkflowWorkspaceCurrentness(workspace, {
      creationIntent,
      inspectLocation,
    }),
  };
}
