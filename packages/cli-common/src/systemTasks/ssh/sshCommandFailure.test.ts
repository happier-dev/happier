import { describe, expect, it } from 'vitest';
import { OpenSshExecutionError } from '../../ssh/openSshRunner.js';
import { readSshCommandFailure } from '@happier-dev/protocol/ssh/commandFailure';
import { sshCommandFailure } from './sshCommandFailure.js';

describe('SSH process failure projection', () => {
  it('retains the transfer exit status without publishing native output', () => {
    const failure = sshCommandFailure(new OpenSshExecutionError('command_failed', 'SCP transfer failed: PRIVATE_STDERR', { status: 23 }));
    const projected = readSshCommandFailure(failure.code, failure.message);
    expect(projected?.message).toContain('exitStatus 23');
    expect(projected?.message).toContain('phase ssh.command');
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_STDERR');
  });
});
