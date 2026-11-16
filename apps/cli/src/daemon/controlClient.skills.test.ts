import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { ensureSkillSessionDirHttp } from './controlClient';

it('retains the materialization owner refusal cause across HTTP', async () => {
  // The daemon HTTP boundary returns the exact startup refusal shape.
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ errorCode: 'skills_unavailable', cause: 'skill_session_identity_mismatch' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  try {
    await expect(ensureSkillSessionDirHttp({ ownerKey: 'session', items: [], nativeDisables: [] }, {
      target: { pid: process.pid, httpPort: address.port, controlToken: 'test-token' },
    })).rejects.toMatchObject({ code: 'skill_session_identity_mismatch' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
