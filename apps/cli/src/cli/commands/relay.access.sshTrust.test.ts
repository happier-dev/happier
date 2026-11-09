import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';

const { promptInput, remoteCommand, unreadableTrust } = vi.hoisted(() => ({
  promptInput: vi.fn<(message: string) => Promise<string>>(),
  remoteCommand: vi.fn(async () => { throw new Error('Stopped at the SSH execution boundary'); }),
  unreadableTrust: { path: '' },
}));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (String(args[0]) === unreadableTrust.path) throw Object.assign(new Error('Read refused'), { code: 'EACCES' });
      return actual.readFileSync(...args);
    },
  };
});

vi.mock('@/terminal/prompts/promptInput', async importOriginal => ({
  ...await importOriginal<typeof import('@/terminal/prompts/promptInput')>(),
  isInteractiveTerminal: () => true,
  promptInput,
}));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: (command: string, args: readonly string[]) => {
    if (command !== 'ssh-keyscan') throw new Error('Unexpected process');
    return { status: 0, stdout: `${args.at(-1)} ssh-ed25519 AAAATEST\n`, stderr: '' };
  },
}));
vi.mock('@happier-dev/cli-common/ssh', async importOriginal => ({
  ...await importOriginal<typeof import('@happier-dev/cli-common/ssh')>(),
  runOpenSshRemoteCommand: remoteCommand,
}));

import { runRelayAccessSubcommand } from './relay/access';
import { runRelayHostSubcommand } from './relay/host';

beforeEach(() => vi.clearAllMocks());

it.each([
  ['access', runRelayAccessSubcommand],
  ['host', runRelayHostSubcommand],
] as const)('seeds explicit relay %s trust while retaining other saved hosts', async (_kind, run) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-relay-access-trust-'));
  const path = join(root, 'known_hosts');
  const original = 'retained.test ssh-ed25519 AAAARETAINED\r\n';
  const approved = 'example.test ssh-ed25519 AAAATEST';
  await writeFile(path, original);
  try {
    await expect(run([
      'status', '--ssh', 'dev@example.test', ...(_kind === 'access' ? ['--ssh-auth', 'agent'] : []), '--known-hosts-path', path,
      '--trusted-host-key', approved,
    ])).rejects.toThrow('Stopped at the SSH execution boundary');
    expect(await readFile(path, 'utf8')).toBe(`${original}${approved}\r\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ['access', runRelayAccessSubcommand],
  ['host', runRelayHostSubcommand],
] as const)('preserves unreadable saved trust when seeding an explicit relay %s host key', async (_kind, run) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-relay-access-trust-'));
  const path = join(root, 'known_hosts');
  const original = 'retained.test ssh-ed25519 AAAARETAINED\n';
  await writeFile(path, original);
  unreadableTrust.path = path;
  try {
    const outcome = await run([
      'status', '--ssh', 'dev@example.test', ...(_kind === 'access' ? ['--ssh-auth', 'agent'] : []), '--known-hosts-path', path,
      '--trusted-host-key', 'example.test ssh-ed25519 AAAATEST',
    ]).then(() => null, (error: unknown) => error);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(outcome).toMatchObject({ code: 'EACCES' });
  } finally {
    unreadableTrust.path = '';
    await rm(root, { recursive: true, force: true });
  }
});

it('merges overlapping relay access approvals with the latest real known_hosts contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-relay-access-trust-'));
  const path = join(root, 'known_hosts');
  const retained = 'retained.test ssh-ed25519 AAAARETAINED';
  await writeFile(path, `${retained}\r\n`, 'utf8');
  const answers: Array<() => void> = [];
  promptInput.mockImplementation(() => new Promise(resolve => answers.push(() => resolve('yes'))));
  const attempts = ['a.test', 'b.test'].map(host => runRelayAccessSubcommand([
    'status', '--ssh', `dev@${host}`, '--ssh-auth', 'agent', '--known-hosts-path', path,
  ]).then(() => null, (error: unknown) => error));
  try {
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[0]!();
    expect(await attempts[0]).toBeInstanceOf(Error);
    answers[1]!();
    expect(await attempts[1]).toBeInstanceOf(Error);
    const persisted = await readFile(path, 'utf8');
    expect(persisted).toContain(retained);
    expect(persisted).toContain('a.test ssh-ed25519 AAAATEST');
    expect(persisted).toContain('b.test ssh-ed25519 AAAATEST');
    expect(remoteCommand).toHaveBeenCalledTimes(2);
  } finally {
    for (const answer of answers) answer();
    await Promise.all(attempts);
    await rm(root, { recursive: true, force: true });
  }
});
