import { describe, it, expect } from 'vitest';
import { resolveMachineRpcWorkingDirectory } from './resolveMachineRpcWorkingDirectory';

describe('resolveMachineRpcWorkingDirectory', () => {
  it('uses the daemon home as the default relative-path base even when restricted roots are configured', () => {
    expect(
      resolveMachineRpcWorkingDirectory({
        env: { HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: '/tmp/happier-machine-root' },
        homedir: () => '/home/user',
        cwd: () => '/work/project',
      }),
    ).toBe('/home/user');
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

  it('defaults to env HOME when provided', () => {
    expect(
      resolveMachineRpcWorkingDirectory({
        env: { HOME: '/scoped/home' },
        homedir: () => '/home/user',
        cwd: () => '/work/project',
      }),
    ).toBe('/scoped/home');
  });

  it('does not use HAPPIER_MACHINE_RPC_WORKING_DIRECTORY as the default directory', () => {
    expect(
      resolveMachineRpcWorkingDirectory({
        env: {
          HOME: '/scoped/home',
          HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: '~/workspace-root',
        },
        homedir: () => '/home/user',
        cwd: () => '/work/project',
      }),
    ).toBe('/scoped/home');
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
