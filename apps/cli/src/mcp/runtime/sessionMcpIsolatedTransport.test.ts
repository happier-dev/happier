import { mkdtemp, rm, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareSessionMcpLocalTransport } from './sessionMcpLocalTransport';

// Only native ACL commands are substituted; filesystem modes, socket listening,
// authentication, and retirement use the real transport owner.
vi.mock('node:child_process', () => ({ execFile: (command: string, args: string[], _options: unknown,
  callback: (error: Error | null, stdout: string) => void) => {
  const path = args.at(-1)!;
  const observed = statSync(path);
  const key = `${observed.dev}:${observed.ino}`;
  if (command === 'setfacl') {
    const grant = args.find(value => value.startsWith('u:'));
    if (grant) grants.set(key, grant);
    callback(null, '');
  } else if (command === 'getfacl') {
    const grant = grants.get(key);
    if (!grant) throw new Error('No native UID grant');
    const directory = observed.isDirectory();
    callback(null, `user::${directory ? 'rwx' : 'rw-'}\nuser:${grant.slice(2)}\ngroup::---\nmask::${directory ? '--x' : 'rw-'}\nother::---\n`);
  } else throw new Error('Unexpected native command');
} }));
const grants = vi.hoisted(() => new Map<string, string>());
const inodeKey = (path: string) => { const entry = statSync(path); return `${entry.dev}:${entry.ino}`; };
afterEach(() => { vi.unstubAllEnvs(); grants.clear(); });

it.skipIf(process.platform !== 'linux')('makes shared and member Session sockets reachable without opening the custodian TMPDIR or peer Sessions', async () => {
  const privateRoot = await mkdtemp('/tmp/happier-private-');
  vi.stubEnv('TMPDIR', privateRoot);
  const transports: Awaited<ReturnType<typeof prepareSessionMcpLocalTransport>>[] = [];
  const servers: ReturnType<typeof createServer>[] = [];
  try {
    for (const uid of [996, 2401, 2402]) {
      const transport = await prepareSessionMcpLocalTransport({ agentUid: uid });
      transports.push(transport);
      const server = createServer((req, res) => {
        res.writeHead(transport.authenticate(req.headers.authorization) ? 200 : 401); res.end();
      });
      servers.push(server);
      await transport.listen(server);
      const context = transport.localContext!;
      // Every ancestor above the private Session leaf must be traversable by
      // the isolated UID; granting only the leaf cannot fix a private TMPDIR.
      for (let parent = dirname(dirname(context.socketPath)); ; parent = dirname(parent)) {
        expect((await stat(parent)).mode & 0o001, parent).toBe(0o001);
        if (parent === dirname(parent)) break;
      }
      expect(transport.contextFilePath).toBeUndefined();
      expect(grants.get(inodeKey(context.socketPath))).toBe(`u:${uid}:rw-`);
      expect(grants.get(inodeKey(dirname(context.socketPath)))).toBe(`u:${uid}:--x`);
      for (const token of [context.bearerToken, undefined, transports[0]!.localContext!.bearerToken]) {
        const status = await new Promise<number | undefined>((resolve, reject) => {
          const call = request({ socketPath: context.socketPath, path: '/mcp',
            headers: token ? { authorization: `Bearer ${token}` } : {} }, response => {
            response.resume(); response.once('end', () => resolve(response.statusCode));
          });
          call.once('error', reject); call.end();
        });
        expect(status).toBe(token === context.bearerToken ? 200 : 401);
      }
    }
    expect((await stat(privateRoot)).mode & 0o777).toBe(0o700);
  } finally {
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const transport of transports) {
      const socket = transport.localContext?.socketPath;
      await transport.retire();
      expect(transport.localContext).toBeUndefined();
      if (socket) await expect(stat(socket)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await rm(privateRoot, { recursive: true, force: true });
  }
});
