import { describe, expect, it } from 'vitest';
import { setSessionCapabilityV1, type SessionCapabilitiesActionPortV1 } from './sessionCapabilities';
import { readActionOutputDiagnostic } from './actionFailureDiagnostic';

const refused = () => Object.assign(new Error('read failed for private-session-title'), { code: 'RPC_FORBIDDEN' });
const port = (overrides: Partial<SessionCapabilitiesActionPortV1>): SessionCapabilitiesActionPortV1 => ({
  readSession: async () => { throw new Error('unexpected read'); },
  resolveItem: async () => { throw new Error('unexpected resolve'); },
  writeMetadata: async () => { throw new Error('unexpected write'); },
  ...overrides,
});
const request = { sessionId: 'session', kind: 'skill' as const, id: 'skill', state: 'on' as const };

describe('Session capability selection refusals', () => {
  it('keeps the closed cause of an unreadable Session privately', async () => {
    const result = await setSessionCapabilityV1({ port: port({ readSession: async () => { throw refused(); } }), request, context: {} });
    expect(JSON.parse(JSON.stringify(result))).toEqual({ ok: false, code: 'session_unavailable' });
    expect(readActionOutputDiagnostic(result)).toMatchObject({ phase: 'session.capabilities.read',
      failureCause: { errorCode: 'RPC_FORBIDDEN' } });
    expect(JSON.stringify(readActionOutputDiagnostic(result))).not.toContain('private-session-title');
  });
});
