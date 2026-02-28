import { describe, it, expect } from 'vitest';
import { resolveMachineRpcWorkingDirectory } from './resolveMachineRpcWorkingDirectory';

describe('resolveMachineRpcWorkingDirectory', () => {
  it('prefers HAPPIER_MACHINE_RPC_WORKING_DIRECTORY when set', () => {
    expect(
      resolveMachineRpcWorkingDirectory({
        env: { HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: '/tmp/happier-machine-root' },
        homedir: () => '/home/user',
        cwd: () => '/work/project',
      }),
    ).toBe('/tmp/happier-machine-root');
  });

  it('defaults to homedir when env var is not set', () => {
    expect(
      resolveMachineRpcWorkingDirectory({
        env: {},
        homedir: () => '/home/user',
        cwd: () => '/work/project',
      }),
    ).toBe('/home/user');
  });

  it('falls back to cwd when homedir is not absolute', () => {
    expect(
      resolveMachineRpcWorkingDirectory({
        env: {},
        homedir: () => 'relative-home',
        cwd: () => '/work/project',
      }),
    ).toBe('/work/project');
  });
});
