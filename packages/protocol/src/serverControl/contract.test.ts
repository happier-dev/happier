import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

describe('serverControl contract exports', () => {
  it('exports per-command envelope schemas', () => {
    expect(typeof (protocol as any).ServerListEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).ServerCurrentEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).ServerAddEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).ServerUseEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).ServerRemoveEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).ServerTestEnvelopeSchema).toBe('object');
    expect(typeof (protocol as any).ServerSetEnvelopeSchema).toBe('object');
  });

  it('validates a server_list envelope shape', () => {
    const schema = (protocol as any).ServerListEnvelopeSchema;
    const parsed = schema.safeParse({
      v: 1,
      ok: true,
      kind: 'server_list',
      data: {
        activeServerId: 'cloud',
        profiles: [
          { id: 'cloud', name: 'cloud', serverUrl: 'http://127.0.0.1:3000', webappUrl: 'http://127.0.0.1:3000' },
        ],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('validates a server_test envelope shape', () => {
    const schema = (protocol as any).ServerTestEnvelopeSchema;
    const parsed = schema.safeParse({
      v: 1,
      ok: true,
      kind: 'server_test',
      data: { ok: false, url: 'http://127.0.0.1:3000/v1/version', status: 500, error: 'http_500' },
    });
    expect(parsed.success).toBe(true);
  });
});
