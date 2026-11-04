import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { prepareSessionMcpLocalTransport } from './sessionMcpLocalTransport';

// Run on an authorized Linux fixture with two existing RunAs identities and an
// executable Node runtime they can read. No users or persistent grants are made.
const users = process.env.HAPPIER_TEST_MCP_AGENT_USERS?.split(',').filter(Boolean) ?? [];
const node = process.env.HAPPIER_TEST_MCP_AGENT_NODE;
const enabled = process.platform === 'linux' && users.length === 2 && !!node;
const requestAsAgent = String.raw`
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  const { own, peer } = JSON.parse(input);
  const request = (context, token) => new Promise(resolve => {
    const call = require('node:http').request({ socketPath: context.socketPath, path: '/mcp',
      headers: { authorization: 'Bearer ' + token } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    call.once('error', error => resolve(error.code)); call.end();
  });
  const result = { uid: process.getuid(), own: await request(own, own.bearerToken),
    wrongToken: await request(own, peer.bearerToken), peer: await request(peer, peer.bearerToken) };
  process.stdout.write(JSON.stringify(result));
});
`;

it.skipIf(!enabled)('allows each real Agent UID only its own authenticated Session socket', async () => {
  const transports: Awaited<ReturnType<typeof prepareSessionMcpLocalTransport>>[] = [];
  const servers: ReturnType<typeof createServer>[] = [];
  try {
    const uids = users.map(user => {
      const identity = spawnSync('id', ['-u', user], { encoding: 'utf8' });
      expect(identity.status).toBe(0);
      return Number(identity.stdout.trim());
    });
    expect(new Set(uids).size).toBe(2);
    expect(uids).not.toContain(process.getuid?.());
    for (const uid of uids) {
      const transport = await prepareSessionMcpLocalTransport({ agentUid: uid });
      transports.push(transport);
      const server = createServer((request, response) => {
        response.writeHead(transport.authenticate(request.headers.authorization) ? 200 : 401);
        response.end();
      });
      servers.push(server);
      await transport.listen(server);
    }
    for (const [index, user] of users.entries()) {
      const child = spawn('sudo', ['-n', '-u', user, '--', node!, '-e', requestAsAgent], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      const terminal = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('close', resolve);
      });
      // Session authentication material remains in stdin, never argv or logs.
      child.stdin.end(JSON.stringify({ own: transports[index]!.localContext,
        peer: transports[1 - index]!.localContext }));
      expect(await terminal, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ uid: uids[index], own: 200, wrongToken: 401, peer: 'EACCES' });
    }
  } finally {
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const transport of transports) await transport.retire();
  }
});
