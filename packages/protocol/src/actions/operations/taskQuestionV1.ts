import type { MachineSudoPasswordPromptV1 } from '../../machines/adminAccessV1.js';
import type { ActionOperationSnapshotV1, ManagedMachineBootstrapPromptV1 } from './v1.js';

export type ActionOperationSudoQuestionV1 = Readonly<{
  id: string;
  taskKind: 'machine.setup.plan.v1' | 'machine.setup.apply.v1' | 'machine.setup.remove.v1' | 'machine.reboot.v1';
  prompt: MachineSudoPasswordPromptV1;
}>;
export type ActionOperationTaskQuestionV1 = ActionOperationSudoQuestionV1 | Readonly<{
  id: string;
  taskKind: 'remote.ssh.bootstrapMachine.v1';
  prompt: Extract<ManagedMachineBootstrapPromptV1, { kind: 'ssh.trustHost' | 'ssh.replaceHostKey' }>;
}>;

/** The operation publishes only the finite task's current, nonsecret question identity. */
export function readActionOperationTaskQuestionV1(snapshot: ActionOperationSnapshotV1): ActionOperationTaskQuestionV1 | null {
  if (snapshot.state !== 'accepted' && snapshot.state !== 'running') return null;
  const domain = snapshot.domainRef;
  if ((domain?.kind === 'machineSetup' || domain?.kind === 'machineReboot')
    && domain.machineId === snapshot.scope.machineId) {
    const task = domain.kind === 'machineSetup' ? domain.setupTask : domain.task;
    return task?.prompt ? { id: task.id, taskKind: task.taskKind, prompt: task.prompt } : null;
  }
  if (domain?.kind !== 'systemTask'
    || domain.prompt?.kind !== 'ssh.trustHost' && domain.prompt?.kind !== 'ssh.replaceHostKey') return null;
  return { id: domain.id, taskKind: domain.taskKind, prompt: domain.prompt };
}
