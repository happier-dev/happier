import { describe, expect, it } from 'vitest';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

describe('PAT Provider Action input admission', () => {
  it('settles malformed Account input before evaluating placement or reaching a transport', async () => {
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43),
        encryption: null,
        credentialProvenance: 'api_token',
      },
      serverId: 'invalid-provider-input-home',
      // No server exists here: malformed input must settle locally.
      serverApiUrl: 'http://127.0.0.1:1',
    });
    await expect(executor.prepare('providers.models.manual.remove', {}, { surface: 'mcp' }))
      .resolves.toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'invalid_parameters' } });
    await expect(executor.execute('providers.models.manual.remove', {}, { surface: 'cli' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it('preserves static Session placement until the current Session is projected into the input', async () => {
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43),
        encryption: null,
        credentialProvenance: 'api_token',
      },
      serverId: 'current-session-input-home',
      serverApiUrl: 'http://127.0.0.1:1',
    });
    await expect(executor.prepare('subagents.plan.start', {
      backendTargetKeys: ['agent:com.acme.agent/acme'], instructions: 'Plan.',
    }, {
      surface: 'cli', defaultSessionId: 'c123456789012345678901234',
    })).resolves.toMatchObject({ kind: 'ready' });
  });
});
