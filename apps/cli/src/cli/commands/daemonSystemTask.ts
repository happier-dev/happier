import { randomUUID } from 'node:crypto';
import type { CommandContext } from '@/cli/commandRegistry';
import { createExecutionRunnerFromKind, createSystemTaskRegistry, executeSystemTask } from '@happier-dev/cli-common/systemTasks';
import { createDaemonSshTunnelTaskKinds } from '@/capabilities/systemTasks/ssh/daemonSshTunnelSystemTasks';
import { writeJsonStdout } from '@/cli/output/jsonEnvelope';

/** hsetup consumes the same tunnel registration as local Machine system tasks. */
export async function handleDaemonSystemTaskCommand(context: CommandContext): Promise<void> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const result = await executeSystemTask({
    registry: createSystemTaskRegistry(Object.entries(createDaemonSshTunnelTaskKinds()).map(([kind, task]) => ({
      kind, handler: createExecutionRunnerFromKind(task),
    }))),
    spec: JSON.parse(input),
    taskId: randomUUID(),
    signal: context.signal,
  });
  await writeJsonStdout(result);
}
