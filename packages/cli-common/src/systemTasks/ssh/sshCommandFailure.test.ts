import { describe, expect, it } from 'vitest';
import { OpenSshExecutionError } from '../../ssh/openSshRunner.js';
import { readSshCommandFailure } from '@happier-dev/protocol/ssh/commandFailure';
import { installRemoteDaemonLifecycle } from '../kinds/remoteDaemonLifecycle.js';
import { sshCommandFailure } from './sshCommandFailure.js';

describe('SSH process failure projection', () => {
  it('preserves the service-manager refusal for the enrollment process fallback', async () => {
    const stdout = JSON.stringify({ ok: false, error: 'service_manager_unavailable', serviceStep: 'preflight',
      serviceStepStatus: 'unavailable', command: { program: 'systemctl', action: 'show-environment' }, message: 'PRIVATE_STDOUT' });
    const failure = sshCommandFailure('', { status: 1, stdout, stderr: '' }, 'daemon.service.install');
    await expect(installRemoteDaemonLifecycle({ preferProcess: false,
      installService: async () => { throw failure; } })).resolves.toBe('process');
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_STDOUT');
  });

  it('does not substitute process startup for a service install error after preflight', async () => {
    const stdout = JSON.stringify({ ok: false, error: 'service_command_failed', serviceStep: 'command', serviceStepStatus: 'failed' });
    const failure = sshCommandFailure('', { status: 1, stdout, stderr: '' }, 'daemon.service.install');
    await expect(installRemoteDaemonLifecycle({ preferProcess: false,
      installService: async () => { throw failure; } })).rejects.toMatchObject({
      details: { kind: 'managedService', step: 'install', exitStatus: 1, cause: { guestCliCode: 'service_command_failed' } },
    });
  });

  it('retains the transfer exit status without publishing native output', () => {
    const failure = sshCommandFailure(new OpenSshExecutionError('command_failed', 'SCP transfer failed: PRIVATE_STDERR', { status: 23 }));
    const projected = readSshCommandFailure(failure.code, failure.message);
    expect(projected?.message).toContain('exitStatus 23');
    expect(projected?.message).toContain('phase ssh.command');
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_STDERR');
  });
});
