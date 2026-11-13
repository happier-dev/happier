import { describe, expect, it, vi } from 'vitest';
import { readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-claude/manifest';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { invokeAccountMachineSourceAction } from './accountMachineActionTransport';

// HTTP is the system boundary; exact-Machine admission and RPC disposition remain real.
const httpGet = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { defaults: {}, get: httpGet } }));

describe('Account Machine Action failure cause', () => {
  it('retains a typed pre-dispatch transport failure as a not-started result', async () => {
    httpGet.mockRejectedValue(Object.assign(new Error('private connection detail'), { code: 'ECONNRESET' }));
    const manifest = normalizePluginManifestV2(PLUGIN_MANIFEST);
    const sourceCustody = { kind: 'managed' as const, immutableGenerationId: 'transport-fixture', installSource: 'archive' as const };
    const result = await invokeAccountMachineSourceAction({
      credentials: { token: 'transport-fixture', encryption: null }, serverUrl: 'https://transport.example.test', machineId: 'machine-fixture',
      callerManifest: manifest, callerSourceCustody: sourceCustody,
      source: { manifest, occurrenceId: 'source-occurrence', sourceCustody },
      request: { action: { pluginId: manifest.id, localId: 'fixture' }, input: {},
        caller: { kind: 'plugin', pluginId: manifest.id, occurrenceId: 'caller-occurrence',
          contribution: { id: 'fixture', qualifiedId: `${manifest.id}/actions/fixture` }, originSurface: 'cli' },
        originSurface: 'cli', signal: new AbortController().signal },
    });
    expect(result).toMatchObject({ status: 'unavailable', actionHandlerInvocation: 'notStarted' });
    expect(readPluginActionFailureAuthorPayload(result.status === 'executed' ? undefined : result.data)).toMatchObject({
      failureCause: { errorCode: 'ECONNRESET', errorClass: 'Error' },
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });
});
