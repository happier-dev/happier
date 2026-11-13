import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildOutboundSessionMessagePayload } from '@/api/session/client/transport/outboundSessionMessagePayload';
import { createSessionHooksService } from './service';

// The session hook server listens on 127.0.0.1 (no kernel peer proof): its secrets are the
// admission. They reach the Agent only as private secret files named in its hook config, never
// the Agent environment, and a transcript echoing a live hook secret is redacted.
describe('session hook secrets and the Agent transcript', () => {
  it('keeps the secrets in private files and redacts them from transcripts while the server is live', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-hook-redaction-'),
    );
    const service = createSessionHooksService({
      happyHomeDir,
      hasCapability: () => true,
    });
    const server = await service.startServer({
      providerId: 'claude',
      sessionId: 'hook-redaction-session',
    });
    try {
      const secrets = await Promise.all(
        [server.sessionHookSecretFile, server.permissionHookSecretFile].map(
          async (file) => (await readFile(file, 'utf8')).trim(),
        ),
      );
      for (const secret of secrets) {
        expect(secret.length).toBeGreaterThan(0);
        expect(JSON.stringify(server).includes(secret)).toBe(false);
        expect(
          Object.values(process.env).some((value) => value?.includes(secret)),
        ).toBe(false);
      }
      const payload = buildOutboundSessionMessagePayload(
        { mode: 'plain' },
        {
          role: 'agent',
          content: {
            type: 'tool-call',
            input: { command: `cat secrets # ${secrets.join(' ')}` },
          },
        },
      );
      for (const secret of secrets)
        expect(JSON.stringify(payload).includes(secret)).toBe(false);
      expect(payload).toMatchObject({
        t: 'plain',
        v: { role: 'agent', content: { type: 'tool-call' } },
      });
    } finally {
      await server.dispose();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
