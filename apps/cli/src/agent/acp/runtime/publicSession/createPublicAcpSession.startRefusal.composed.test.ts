import { expect, it } from 'vitest';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createPublicAcpSession } from './createPublicAcpSession';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';

it('retains a non-ACP executable transport refusal in the public startup diagnostic consumed by host publication', async () => {
  // Portable equivalent of Account A's /bin/echo exact-argument fixture: stdout
  // contains ordinary text and the process exits before an ACP handshake.
  const nativeSource = `process.stdout.write(' two words   padded  \\n');`;
  await withTempDir('acp-native-transport-refusal-', async directory => {
    const script = writeAcpTestAgentScript({ dir: directory, fileName: 'echo.mjs', source: nativeSource });
    const lifetime = new AbortController();
    const publications = createNativeAgentSessionPublications({ agentId: 'acp-start-canary', session: null,
      signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted, supportsInFlightSteer: false });
    try {
      const refusal: unknown = await createPublicAcpSession({ kind: 'create',
        sessionId: 'c1234567890123456789012345', cwd: directory }, {
        transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'native-cli' }, args: [] },
      }, {
        pluginId: 'acme.start-canary', agentId: 'acp-start-canary', signal: lifetime.signal,
        isCurrent: () => !lifetime.signal.aborted,
        // The installed executable lookup is the OS boundary; ACP and failure
        // classification run their production implementations.
        systemTools: { resolve: async () => ({ toolId: 'native-cli', launch: { kind: 'binary',
          executablePath: process.execPath, args: [script], env: {} } }) },
        interactions: { async request() { throw new Error('Unexpected ACP interaction'); } },
        media: { async registerSourceRoot() { throw new Error('Unexpected ACP media'); } },
        models: publications.services.models, modes: publications.services.modes,
      }).then(async session => { await session.dispose(); throw new Error('Non-ACP command unexpectedly opened'); }, error => error);
      expect(refusal).toMatchObject({ code: 'agent_startup_transport_failed' });
      expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: refusal })).toMatchObject({
        code: 'agent_startup_transport_failed', source: 'agent_session_error', status: 'failed',
      });
    } finally { lifetime.abort(); publications.dispose(); }
  });
});
