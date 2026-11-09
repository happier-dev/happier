import { describe, expect, it } from 'vitest';
import { classifyHappyProcess } from './doctor';

describe('classifyHappyProcess', () => {
  it.each([
    ['/repo/apps/cli/src/index.ts', '/repo/packages/cli-common/registerSourceRuntime.mjs'],
    ['C:\\repo\\apps\\cli\\src\\index.ts', 'C:\\repo\\packages\\cli-common\\registerSourceRuntime.mjs'],
  ])('recognizes canonical registered-source daemons and Sessions: %s', (entrypoint, registration) => {
    const command = `node --conditions=happier-source --import "${registration}" "${entrypoint}"`;
    expect(classifyHappyProcess({ pid: 123, name: 'node', cmd: `${command} daemon start-sync` }))
      .toMatchObject({ type: 'daemon' });
    expect(classifyHappyProcess({ pid: 123, name: 'node', cmd: `${command} session --started-by daemon` }))
      .toMatchObject({ type: 'daemon-spawned-session' });
  });

  it.each([
    ['node', '/repo/apps/other/src/index.ts'],
    ['node', '/repo/apps/cli/src/index.ts.extra'],
    ['unrelated', '/repo/apps/cli/src/index.ts'],
  ])('rejects unrelated registered-source processes: %s %s', (name, entrypoint) => {
    expect(classifyHappyProcess({ pid: 123, name,
      cmd: `${name} --conditions=happier-source --import /repo/packages/cli-common/registerSourceRuntime.mjs ${entrypoint} daemon start-sync`,
    })).toBeNull();
  });

  it.each([
    '/home/happier/.happier/dev-targets/nl1/stack-state/source-bundles/bundle-a/apps/cli/src/index.mjs',
    'C:\\happier\\stack-state\\source-bundles\\bundle-a\\apps\\cli\\src\\index.mjs',
  ])('recognizes the built Stack Session runner entrypoint %s', entrypoint => {
    expect(classifyHappyProcess({ pid: 123, name: 'MainThread',
      cmd: `node "${entrypoint}" claude --happy-starting-mode remote --started-by daemon`,
    })).toMatchObject({ type: 'daemon-spawned-session' });
    expect(classifyHappyProcess({ pid: 123, name: 'node',
      cmd: `node "${entrypoint}" daemon start-sync`,
    })).toMatchObject({ type: 'daemon' });
  });

  it.each(['/repo/apps/other/src/index.mjs', '/repo/apps/cli/src/index.mjs.extra'])('rejects unrelated built entrypoints %s', entrypoint => {
    expect(classifyHappyProcess({ pid: 123, name: 'node', cmd: `node ${entrypoint} --started-by daemon` })).toBeNull();
  });
  it('should ignore unrelated processes with "happy" in the name', () => {
    const res = classifyHappyProcess({ pid: 123, name: 'happy-hour', cmd: 'happy-hour --serve' });
    expect(res).toBeNull();
  });

  it('should detect a daemon process started from dist', () => {
    const res = classifyHappyProcess({
      pid: 123,
      name: 'node',
      cmd: '/usr/bin/node /repo/dist/index.mjs daemon start-sync',
    });
    expect(res).not.toBeNull();
    expect(res!.type).toBe('daemon');
  });

  it('should detect a daemon-spawned session process', () => {
    const res = classifyHappyProcess({
      pid: 123,
      name: 'node',
      cmd: '/usr/bin/node /repo/dist/index.mjs --started-by daemon',
    });
    expect(res).not.toBeNull();
    expect(res!.type).toBe('daemon-spawned-session');
  });

  it('should detect a daemon-spawned session process from package-dist when the census reports MainThread', () => {
    const res = classifyHappyProcess({
      pid: 123,
      name: 'MainThread',
      cmd: '/usr/bin/node /repo/cli-preview/versions/0.2.4/package-dist/index.mjs codex --happy-starting-mode remote --started-by daemon',
    });
    expect(res).not.toBeNull();
    expect(res!.type).toBe('daemon-spawned-session');
  });

  it('should detect a daemon-spawned dev session when ps reports the full node executable path', () => {
    const res = classifyHappyProcess({
      pid: 123,
      name: '/Users/leeroy/.local/share/fnm/node-versions/v22.22.1/installation/bin/node',
      cmd: '/Users/leeroy/.local/share/fnm/node-versions/v22.22.1/installation/bin/node --no-warnings --no-deprecation --import /repo/node_modules/tsx/dist/esm/index.mjs /repo/apps/cli/src/index.ts codex --happy-starting-mode remote --started-by daemon',
    });
    expect(res).not.toBeNull();
    expect(res!.type).toBe('dev-daemon-spawned');
  });

  it('should detect a packaged Windows daemon-spawned session process when the census reports happier.exe', () => {
    const res = classifyHappyProcess({
      pid: 123,
      name: 'happier.exe',
      cmd: 'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
    });
    expect(res).not.toBeNull();
    expect(res!.type).toBe('daemon-spawned-session');
  });

  it('should detect a dev daemon started from tsx', () => {
    const res = classifyHappyProcess({
      pid: 123,
      name: 'node',
      cmd: '/usr/bin/node /repo/apps/cli/node_modules/.bin/tsx /repo/apps/cli/src/index.ts daemon start-sync',
    });
    expect(res).not.toBeNull();
    expect(res!.type).toBe('dev-daemon');
  });

  it('classifies ordinary foreground source runners as sessions without requiring unsafe provider flags', () => {
    const res = classifyHappyProcess({
      pid: 123,
      name: 'node',
      cmd: '/usr/bin/node --import /repo/node_modules/tsx/dist/esm/index.mjs /repo/apps/cli/src/index.ts claude --model sonnet --permission-mode read_only',
    });
    expect(res?.type).toBe('dev-session');
  });

  it('preserves daemon ownership scope extracted from the process environment', () => {
    const res = classifyHappyProcess({
      pid: 123,
      name: 'node',
      cmd: '/usr/bin/node /repo/apps/cli/node_modules/.bin/tsx /repo/apps/cli/src/index.ts daemon start-sync',
      daemonOwnershipEnvironmentVariables: {
        HAPPIER_HOME_DIR: '/tmp/happier-stack/cli',
        HAPPIER_ACTIVE_SERVER_ID: 'stack_current__id_default',
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
      },
    });
    expect(res).not.toBeNull();
    expect(res!.daemonOwnershipEnvironmentVariables).toEqual({
      HAPPIER_HOME_DIR: '/tmp/happier-stack/cli',
      HAPPIER_ACTIVE_SERVER_ID: 'stack_current__id_default',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
    });
  });

  it('should detect a daemon-spawned session launched from a CLI source snapshot', () => {
    const res = classifyHappyProcess({
      pid: 123,
      name: 'node',
      cmd: '/usr/bin/node --import /repo/node_modules/tsx/dist/esm/index.mjs /repo/.project/tmp/cli-dist-snapshot/src/index.ts claude --happy-starting-mode remote --started-by daemon',
    });
    expect(res).not.toBeNull();
    expect(res!.type).toBe('dev-daemon-spawned');
  });

  it('should detect daemon-spawned snapshot sessions launched without tsx import hook', () => {
    const res = classifyHappyProcess({
      pid: 123,
      name: 'node',
      cmd: '/usr/bin/node /repo/.project/tmp/cli-dist-snapshot/src/index.ts claude --happy-starting-mode remote --started-by daemon',
    });
    expect(res).not.toBeNull();
    expect(res!.type).toBe('daemon-spawned-session');
  });

  it('should detect a quoted Windows daemon-spawned session from a published source-copy snapshot', () => {
    const res = classifyHappyProcess({
      pid: 123,
      name: 'C:\\Program Files\\nodejs\\node.exe',
      cmd: '"C:\\Program Files\\nodejs\\node.exe" --import C:\\repo\\node_modules\\tsx\\dist\\esm\\index.mjs --no-warnings --no-deprecation "C:\\repo\\.project\\tmp\\cli-source-snapshot-source-51405-1785848300000-1\\src\\index.ts" pi --happy-starting-mode remote --started-by daemon',
    });
    expect(res).not.toBeNull();
    expect(res!.type).toBe('dev-daemon-spawned');
  });

  it.each([
    '/repo/.project/tmp/arbitrary-source-51405-1785848300000-1/src/index.ts',
    '/repo/.project/tmp/cli-dist-source-51405-1785848300000-1/src/index.ts',
    '/repo/.project/tmp/cli-source-snapshot-source-current/src/index.ts',
    '/repo/.project/tmp/cli-source-snapshot-source-51405-1785848300000-1-extra/src/index.ts',
  ])('does not classify a non-canonical source-copy snapshot path: %s', (entrypoint) => {
    const res = classifyHappyProcess({
      pid: 123,
      name: 'node',
      cmd: `/usr/bin/node --import /repo/node_modules/tsx/dist/esm/index.mjs ${entrypoint} pi --happy-starting-mode remote --started-by daemon`,
    });
    expect(res).toBeNull();
  });
});
