import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

describe('BackendExternalSessionsCapabilitiesV1Schema', () => {
  it('parses the external-session capability block without provider-specific branches', () => {
    const schema = protocol.BackendExternalSessionsCapabilitiesV1Schema;
    expect(schema, 'BackendExternalSessionsCapabilitiesV1Schema must be exported').toBeDefined();
    expect(schema.safeParse).toBeTypeOf('function');

    expect(schema.parse({
      listCandidates: true,
      attach: true,
      transcript: {
        page: true,
        follow: true,
        import: false,
      },
      takeover: {
        externalLinked: true,
        persisted: true,
        forceStop: true,
        targetRuntimeModes: {
          terminal: true,
          remote: false,
        },
      },
      futureCapability: 'kept',
    })).toMatchObject({
      listCandidates: true,
      takeover: {
        targetRuntimeModes: {
          terminal: true,
          remote: false,
        },
      },
      futureCapability: 'kept',
    });
  });
});
