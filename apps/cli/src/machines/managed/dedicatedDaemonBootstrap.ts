import { randomUUID } from 'node:crypto';
import { prepareDedicatedDaemonBootstrap as prepareSharedDedicatedDaemonBootstrap, type DedicatedDaemonBootstrapInput } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';

type WithoutPromptId<Input> = Input extends unknown ? Omit<Input, 'createPromptId'> : never;

/** The CLI supplies OS entropy; shared composition owns the dedicated bootstrap. */
export async function prepareDedicatedDaemonBootstrap(input: WithoutPromptId<DedicatedDaemonBootstrapInput>): Promise<void> {
  await prepareSharedDedicatedDaemonBootstrap({ ...input, createPromptId: randomUUID });
}
