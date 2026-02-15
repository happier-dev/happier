import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

describe('serverControl contract exports', () => {
  it('exports ServerListEnvelopeSchema', () => {
    expect(typeof (protocol as any).ServerListEnvelopeSchema).toBe('object');
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
});

