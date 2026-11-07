import type { ExternalActionTargetV1 } from '@happier-dev/protocol';

import { argvBeforeOptionTerminator, readRepeatedFlagValues } from '../commands/shared/argvFlags';

import { ACTION_CLI_MACHINE_ID_FLAG } from './flags';

export const ACTION_CLI_PROJECT_DIRECTORY_FLAG = '--project-directory' as const;
export const ACTION_CLI_WORKSPACE_REF_ID_FLAG = '--workspace-ref-id' as const;
export const ACTION_CLI_PROJECT_TARGET_VALUE_FLAGS = Object.freeze([
  ACTION_CLI_PROJECT_DIRECTORY_FLAG,
  ACTION_CLI_WORKSPACE_REF_ID_FLAG,
]);

export function isWorkflowActionCliCommand(actionId: string): boolean {
  return actionId.startsWith('workflow.');
}

/** Generic invocation and Workflow aliases carry the same exact transport target. */
export function readActionCliExecutionTarget(
  argv: readonly string[],
  machineId: string | null | undefined,
): ExternalActionTargetV1 | undefined {
  const options = argvBeforeOptionTerminator(argv);
  const readValue = (flag: string) => {
    try {
      const values = readRepeatedFlagValues(options, flag);
      if (values.length > 1) throw new Error(`Provide ${flag} once.`);
      return values[0];
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(`Invalid ${flag}.`), { code: 'invalid_arguments' });
    }
  };
  const projectDirectory = readValue(ACTION_CLI_PROJECT_DIRECTORY_FLAG);
  const workspaceRefId = readValue(ACTION_CLI_WORKSPACE_REF_ID_FLAG);
  if ((projectDirectory || workspaceRefId) && !machineId) {
    throw Object.assign(new Error(`${ACTION_CLI_MACHINE_ID_FLAG} is required for a Workflow project target.`), { code: 'invalid_arguments' });
  }
  if (workspaceRefId && !projectDirectory) {
    throw Object.assign(new Error(`${ACTION_CLI_PROJECT_DIRECTORY_FLAG} is required with ${ACTION_CLI_WORKSPACE_REF_ID_FLAG}.`), { code: 'invalid_arguments' });
  }
  return machineId ? {
    kind: 'machine', machineId,
    ...(projectDirectory ? { project: { machineId, directory: projectDirectory,
      ...(workspaceRefId ? { workspaceRefId } : {}),
    } } : {}),
  } : undefined;
}
