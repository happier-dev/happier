import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { lstatSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Where a Session host (and a session holder) places its unix socket when the preferred owner-only
 * roots cannot hold the path: never a shared world-writable directory, where a same-uid process that
 * may write there (a provider sandbox) could replace the listener, yet still a local endpoint.
 */
const env = vi.hoisted(() => {
  // Short fixture root: the per-user temp directory must leave room for a holder socket leaf.
  const root = `/tmp/hlr-${process.pid}-${Date.now() % 1_000_000}`;
  process.env.HAPPIER_HOME_DIR = `${root}/${'h'.repeat(90)}`;
  delete process.env.XDG_RUNTIME_DIR;
  return { root, happyHome: process.env.HAPPIER_HOME_DIR, shortHome: `${root}/user-home`, longHome: `${root}/${'u'.repeat(90)}` };
});

import { registerLocalSessionRpcTarget } from './localSessionRpcChannel';
import { createSessionHolderSocketPath } from '@/subprocess/supervision/sessionHolder';

function token(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub, extras: { provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } } })).toString('base64url');
  return `h.${payload}.s`;
}

async function findDescriptors(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) found.push(join(entry.parentPath, entry.name));
  }
  return found;
}

/** Register one Session target; the endpoint's root (the parent of its private directory), or the refusal. */
async function hostEndpointRoot(): Promise<string> {
  const retire = await registerLocalSessionRpcTarget({ sessionId: 'sess-root-1', credentialToken: token('acct-1'),
    handleRequest: async () => ({}), cancelRequest: () => {}, readTrustedCaller: async () => null });
  try {
    const [file] = await findDescriptors(join(env.happyHome, 'servers'));
    return dirname(dirname(JSON.parse(await readFile(file!, 'utf8')).endpoint.path));
  } finally { await retire(); }
}

const uid = process.getuid?.() ?? 0;
async function freshTemp(): Promise<string> {
  await mkdir(env.root, { recursive: true });
  const temp = await mkdtemp(join(env.root, 't-'));
  process.env.TMPDIR = temp;
  return temp;
}

function shape(path: string) {
  const entry = lstatSync(path);
  return { mode: entry.mode & 0o777, ours: entry.uid === uid, symlink: entry.isSymbolicLink() };
}

describe.skipIf(process.platform === 'win32')('owner-only local socket root', () => {
  const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
  afterEach(() => {
    process.env.HOME = saved.HOME;
    process.env.TMPDIR = saved.TMPDIR;
    vi.restoreAllMocks();
  });
  afterAll(async () => { await rm(env.root, { recursive: true, force: true }); });

  it('long Happier home: a short owner-only directory under the user home', async () => {
    process.env.HOME = env.shortHome;
    await freshTemp();
    const root = await hostEndpointRoot();
    expect([root, shape(root)]).toEqual([join(env.shortHome, '.happier-run'), { mode: 0o700, ours: true, symlink: false }]);
  });

  it('long Happier home and long user home: the host still starts in a per-user 0700 directory under the system temp dir', async () => {
    process.env.HOME = env.longHome;
    const temp = await freshTemp();
    const root = await hostEndpointRoot();
    expect([root, shape(root)]).toEqual([join(temp, `happier-${uid}`), { mode: 0o700, ours: true, symlink: false }]);
    // The session holder places its sockets under the same root (one rule, one helper).
    expect(dirname(dirname(createSessionHolderSocketPath()))).toBe(root);
  });

  it('refuses a pre-created per-user temp directory that is loose, a symlink, or not ours', async () => {
    process.env.HOME = env.longHome;
    const outcomes: string[] = [];
    const attempt = async () => {
      outcomes.push(await hostEndpointRoot().then(() => 'served', () => 'refused'));
      outcomes.push((() => { try { createSessionHolderSocketPath(); return 'served'; } catch { return 'refused'; } })());
    };

    const loose = join(await freshTemp(), `happier-${uid}`);
    await mkdir(loose, { mode: 0o700 });
    await chmod(loose, 0o755);
    await attempt();

    const temp = await freshTemp();
    await mkdir(join(temp, 'elsewhere'), { mode: 0o700 });
    await symlink(join(temp, 'elsewhere'), join(temp, `happier-${uid}`));
    await attempt();

    // Owned by another uid: this process plays uid+1, so the directory (ours) is foreign to it.
    const foreign = join(await freshTemp(), `happier-${uid + 1}`);
    await mkdir(foreign, { mode: 0o700 });
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    await attempt();

    expect(outcomes).toEqual(['refused', 'refused', 'refused', 'refused', 'refused', 'refused']);
    expect(shape(loose).mode).toBe(0o755);
  });
});
