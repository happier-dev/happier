import { expect, it } from 'vitest';
import { MachineRecipeV1Schema, resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { BACKUP_RECEIVER_RECIPE } from './backupReceiver.js';

it('requires effective receiver restrictions on apply and preserves only administrator policy on removal', () => {
  const recipe = MachineRecipeV1Schema.parse({ id: 'backup-receiver', ...BACKUP_RECEIVER_RECIPE });
  const inputs = { username: 'receiver', chrootPath: '/srv/receiver', repositoryPath: '/srv/receiver/repository',
    senderPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJXmQhNPw7NtvqN7BA5pjk3OmlG6GgD2uXfMWLNa7z5h',
    connection: { host: 'probe', address: '192.0.2.1' },
    administrator: { username: 'operator', host: 'probe', address: '192.0.2.2' }, sshServiceUnit: 'ssh.service' };
  const policy = recipe.steps.map(step => resolveMachineRecipeStepInputsV1(step, inputs)).find(step => step.id === 'receiver-ssh-policy');
  const removal = recipe.removeSteps!.map(step => resolveMachineRecipeStepInputsV1(step, inputs)).find(step => step.id === 'receiver-ssh-policy');
  const admin = { user: 'operator', host: 'probe', address: '192.0.2.2' };
  expect(policy).toMatchObject({ validate: { kind: 'sshd', contexts: [
    { user: 'receiver', expected: { chrootdirectory: '/srv/receiver', forcecommand: 'internal-sftp', authenticationmethods: 'publickey',
      pubkeyauthentication: 'yes', passwordauthentication: 'no', kbdinteractiveauthentication: 'no', disableforwarding: 'yes',
      permittty: 'no', permittunnel: 'no', permituserrc: 'no', authorizedkeysfile: '/etc/ssh/happier-backup-keys/receiver' } }, admin,
  ] } });
  expect(removal).toMatchObject({ state: 'absent', validate: { kind: 'sshd', contexts: [admin] }, probe: { kind: 'sshd', contexts: [admin] } });
});
