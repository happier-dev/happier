import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import { callSessionMcpTool } from '@/cli/commands/toolsSessionMcp';
import { withSessionMcpAgentLaunchMaterial } from '@/daemon/agentIsolation/agentLaunchMaterials';
import { startHappyServer } from '@/mcp/startHappyServer';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { readSessionMcpContextFromEnvironment, SESSION_MCP_CONTEXT_FILE_ENV,
  supportsSessionMcpLocalTransport } from './sessionMcpLocalTransport';

// Daemon IPC is outside the Session process. Keep the shell command, context
// reader, SDK, Unix HTTP transport, tool registration and Action executor real.
vi.mock('@/daemon/controlClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  readDaemonPluginCatalog: async () => ({ kind: 'available', plugins: [], tools: [] }),
  requestDaemonPluginActionExecution: async () => ({ matched: false }),
}));

afterEach(() => { vi.unstubAllEnvs(); });

function createActiveSession(sessionId: string) {
  return Object.assign(createMutableApiSessionClientFixture({ sessionId, metadata: createTestMetadata() }), {
    getWorkDepth: () => 0,
    getActiveTurnPermissionWitness: () => ({ turnId: 'shell-turn', workDepth: 0,
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } } as const),
  });
}

describe.skipIf(!supportsSessionMcpLocalTransport())('Agent shell Session MCP capability', () => {
  it('executes an Action with the Agent context while refusing private daemon operations', async () => {
    const session = createActiveSession('shell-capability');
    const server = await startHappyServer(session, { localTransport: { agentUid: process.getuid!() },
      sessionCredentials: { token: 'shell-session-fixture', encryption: null }, accountSettings: accountSettingsParse({}) });
    try {
      vi.stubEnv(SESSION_MCP_CONTEXT_FILE_ENV, server.contextFilePath!);
      const context = await readSessionMcpContextFromEnvironment();
      const launchMaterial = withSessionMcpAgentLaunchMaterial({ runtimeHome: '/agent/runtime',
        environment: {}, selectedMaterials: [] }, context);
      const material = launchMaterial.selectedMaterials[0];
      if (!material) throw new Error('Missing Agent Session MCP material');
      expect(JSON.parse(Buffer.from(material.contentBase64, 'base64').toString('utf8'))).toEqual(context);
      expect(context).toEqual(server.localContext);

      const allowed = await callSessionMcpTool({ source: 'happier', toolName: 'action_execute',
        args: { actionId: 'action.spec.get', input: { id: 'session.title.set' } } });
      expect(allowed, JSON.stringify(allowed))
        .toMatchObject({ ok: true, result: { actionSpec: { id: 'session.title.set' } } });

      for (const operation of ['managed_server.secret.read', 'agent_start.policy.read']) {
        const args = { requestId: 'private-operation', secretId: 'private-secret', canonicalOrigin: 'https://private.invalid' };
        expect(await callSessionMcpTool({ source: 'happier', toolName: operation, args }))
          .toMatchObject({ ok: false, errorCode: 'unknown_tool' });
        expect(await callSessionMcpTool({ source: 'happier', toolName: 'action_execute',
          args: { actionId: operation, input: args } })).toMatchObject({ ok: false });
      }
    } finally {
      await server.stop();
      await session.close();
    }
  });

  it('refuses a captured Agent context after its Session transport ends', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'captured-agent-mcp-'));
    const session = createActiveSession('ended-shell-capability');
    const server = await startHappyServer(session, { localTransport: { agentUid: process.getuid!() },
      sessionCredentials: { token: 'shell-session-fixture', encryption: null }, accountSettings: accountSettingsParse({}) });
    try {
      const context = await readSessionMcpContextFromEnvironment({ [SESSION_MCP_CONTEXT_FILE_ENV]: server.contextFilePath });
      const captured = join(directory, 'context.json');
      await writeFile(captured, JSON.stringify(context), { mode: 0o600 });
      vi.stubEnv(SESSION_MCP_CONTEXT_FILE_ENV, captured);
      const request = { source: 'happier', toolName: 'action_execute',
        args: { actionId: 'action.spec.get', input: { id: 'session.title.set' } } };
      const allowed = await callSessionMcpTool(request);
      expect(allowed, JSON.stringify(allowed)).toMatchObject({ ok: true });
      await server.stop();
      // The captured file still contains the original endpoint and bearer;
      // refusal comes from retiring the Session, rather than losing the file.
      expect(await readSessionMcpContextFromEnvironment()).toEqual(context);
      expect(await callSessionMcpTool(request))
        .toMatchObject({ ok: false, errorCode: 'mcp_socket_access_unavailable' });
    } finally {
      await server.stop();
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
