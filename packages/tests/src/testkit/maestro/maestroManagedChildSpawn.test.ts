import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Maestro CLIs spawn a resolved-or-bare Maestro binary — `maestro.bat` on
// Windows, frequently under a spaced user path. This asserts the spawn owner they
// import is the canonical managed-child owner, which is what knows that Windows
// cannot start a `.cmd`/`.bat` from argv and that a shell would corrupt argv.
import {
  runManagedChildCommand,
} from '../../../../../scripts/testing/process/managedChildLifecycle.mjs';

type SpawnCall = {
  command: string;
  args: readonly string[];
  options: Record<string, unknown>;
};

class FakeChild extends EventEmitter {
  // A zero pid keeps lifecycle cleanup away from a real process tree; the
  // signal-handler teardown it also performs stays observable.
  readonly pid = 0;
  readonly kill = vi.fn();
}

const spawnCalls: SpawnCall[] = [];
let lastChild: FakeChild | null = null;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: Record<string, unknown>) => {
      spawnCalls.push({ command, args, options });
      lastChild = new FakeChild();
      return lastChild;
    },
  };
});

const originalPlatform = process.platform;
const originalComspec = process.env.COMSPEC;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

async function runAndExit(params: Parameters<typeof runManagedChildCommand>[0]): Promise<void> {
  const running = runManagedChildCommand(params);
  await Promise.resolve();
  lastChild?.emit('exit', 0, null);
  await running;
}

beforeEach(() => {
  spawnCalls.length = 0;
  lastChild = null;
  process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe';
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  if (originalComspec === undefined) delete process.env.COMSPEC;
  else process.env.COMSPEC = originalComspec;
});

describe('the managed-child spawn owner the Maestro CLIs use', () => {
  it('routes a spaced Windows maestro.bat shim through the escaped comspec invocation', async () => {
    setPlatform('win32');

    await runAndExit({
      command: 'C:\\Users\\Ada Lovelace\\AppData\\Local\\maestro\\bin\\maestro.bat',
      args: ['test', '--env', 'HAPPIER_E2E_SERVER_URL=http://127.0.0.1:26050', 'flows/F1.yaml'],
      spawnOptions: { stdio: 'inherit' },
    });

    const call = spawnCalls[0];
    expect(call?.command).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(call?.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(String(call?.args.at(-1))).toContain('Ada^ Lovelace');
    expect(String(call?.args.at(-1))).toContain('maestro.bat');
    expect(call?.options.windowsVerbatimArguments).toBe(true);
  });

  it('starts an explicit spaced Windows executable from argv and refuses a caller shell', async () => {
    setPlatform('win32');

    await runAndExit({
      command: 'C:\\Program Files\\maestro\\bin\\maestro.exe',
      args: ['test', 'C:\\Users\\Ada Lovelace\\flows\\F1.yaml'],
      // A shell concatenates argv into one unescaped command line (Node DEP0190),
      // so the spawn owner keeps ownership of how the child starts.
      spawnOptions: { stdio: 'inherit', shell: true },
    });

    const call = spawnCalls[0];
    expect(call?.command).toBe('C:\\Program Files\\maestro\\bin\\maestro.exe');
    expect(call?.args).toEqual(['test', 'C:\\Users\\Ada Lovelace\\flows\\F1.yaml']);
    expect(call?.options.shell).toBeUndefined();
    expect(call?.options.windowsVerbatimArguments).toBeUndefined();
  });

  it('starts a spaced executable directly on every other platform', async () => {
    setPlatform('darwin');

    await runAndExit({
      command: '/Users/ada lovelace/.maestro/bin/maestro',
      args: ['test', '/Users/ada lovelace/flows/F1.yaml'],
      spawnOptions: { stdio: 'inherit' },
    });

    const call = spawnCalls[0];
    expect(call?.command).toBe('/Users/ada lovelace/.maestro/bin/maestro');
    expect(call?.args).toEqual(['test', '/Users/ada lovelace/flows/F1.yaml']);
    expect(call?.options.detached).toBe(true);
  });

  it('releases its process signal handlers once the child exits', async () => {
    setPlatform('darwin');
    const baseline = process.listenerCount('SIGINT');

    const running = runManagedChildCommand({
      command: '/usr/local/bin/maestro',
      args: ['test'],
      spawnOptions: { stdio: 'inherit' },
    });
    await Promise.resolve();
    expect(process.listenerCount('SIGINT')).toBe(baseline + 1);

    lastChild?.emit('exit', 0, null);
    await running;

    expect(process.listenerCount('SIGINT')).toBe(baseline);
  });
});
