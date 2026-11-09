import { describe, expect, it } from 'vitest';

import { createUnixAgentIdentityLaunch } from './unixAgentIdentityAdapter';
import { readAgentLaunchFrame } from './agentLaunchFrame';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { prepareSessionMcpLocalTransport } from '@/mcp/runtime/sessionMcpLocalTransport';
import { createAgentIsolationSessionContext } from './agentIsolationSessionContext';

describe('Unix Agent identity launch', () => {
  it.skipIf(!process.getuid)('carries the live Session context as selected frame material with only a path in Agent env', async () => {
    const transport = await prepareSessionMcpLocalTransport({ agentUid: process.getuid!() });
    const server = createServer();
    try {
      await transport.listen(server);
      const sessionMcpContext = transport.localContext;
      if (!sessionMcpContext) throw new Error('Current Session context unavailable');
      const input = {
        managedHappierBinaryPath: '/opt/happier/current/bin/happier',
        executable: '/opt/happier/tools/agent', args: [], cwd: '/srv/happier/project',
        runtimeHome: '/var/lib/happier-agent/runtime/admitted-lease',
        environment: { PATH: '/usr/bin', HAPPIER_SESSION_MCP_CONTEXT_FILE: '/stale/context' },
        selectedEnvironmentKeys: [],
        selectedMaterials: [{ relativePath: 'selected.bin', contentBase64: 'AP8=' }],
        sessionMcpContext,
      };
      const launch = createUnixAgentIdentityLaunch(input);
      const frame = await readAgentLaunchFrame(Readable.from([launch.stdinPreamble], { objectMode: false }));
      expect(frame.selectedMaterials).toEqual([
        ...input.selectedMaterials,
        { relativePath: '.happier/session-mcp.json', contentBase64: Buffer.from(JSON.stringify(sessionMcpContext)).toString('base64') },
      ]);
      expect(frame.environment).toEqual({ PATH: '/usr/bin',
        HAPPIER_SESSION_MCP_CONTEXT_FILE: `${input.runtimeHome}/.happier/session-mcp.json` });
      expect(JSON.stringify({ args: launch.args, env: launch.env })).not.toContain(sessionMcpContext.bearerToken);
      await transport.retire();
      const finite = createUnixAgentIdentityLaunch({ ...input, sessionMcpContext: undefined });
      const finiteFrame = await readAgentLaunchFrame(Readable.from([finite.stdinPreamble], { objectMode: false }));
      expect(finiteFrame.selectedMaterials).toEqual(input.selectedMaterials);
      expect(finiteFrame.environment).not.toHaveProperty('HAPPIER_SESSION_MCP_CONTEXT_FILE');
      const session = createAgentIsolationSessionContext({
        machine: { read: () => ({ enabled: true, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' },
          workspaceRoots: ['/srv/happier/project'] }) }, managedHappierBinaryPath: input.managedHappierBinaryPath,
        readMaterial: () => frame,
      });
      await expect(session.prepareLaunch!({ sessionMcpContext: undefined })).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await transport.retire();
    }
  });

  it('keeps selected secrets solely in stdin and excludes custodian environment', async () => {
    const launch = createUnixAgentIdentityLaunch({
      managedHappierBinaryPath: '/opt/happier/current/bin/happier',
      executable: '/opt/happier/tools/agent', args: ['--stdio'], cwd: '/srv/happier/project',
      runtimeHome: '/home/happier-agent/.local/state/happier/runtime/session',
      environment: { PATH: '/opt/happier/tools:/usr/bin', ANTHROPIC_API_KEY: 'selected',
        HAPPIER_TEST_SELECTED_ACCESS_TOKEN: 'selected-account-token', HAPPIER_TEST_UNSELECTED_ACCESS_TOKEN: 'unselected-account-token',
        HAPPIER_FIRST_PARTY_INSTALL_HOME: '/opt/happier',
        HAPPIER_MANAGED_TOOLS_ROOT: '/var/lib/happier/tools/personal-install',
        HAPPIER_HOME_DIR: '/private/daemon', HAPPIER_DAEMON_TOKEN: 'custodian-token-sentinel', RANDOM_SECRET: 'unselected',
        HAPPIER_SESSION_CREDENTIAL_FILE: '/private/source-credential-sentinel',
        HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: '/private/host-mcp-config',
        HAPPIER_SESSION_MCP_CONTEXT_FILE: '/home/happier-agent/.local/state/happier/runtime/session/.happier/session-mcp.json' },
      selectedEnvironmentKeys: ['ANTHROPIC_API_KEY', 'HAPPIER_TEST_SELECTED_ACCESS_TOKEN', 'HAPPIER_FIRST_PARTY_INSTALL_HOME', 'HAPPIER_HOME_DIR', 'HAPPIER_DAEMON_TOKEN', 'HAPPIER_SESSION_CREDENTIAL_FILE', 'HAPPIER_SESSION_MCP_CONTEXT_FILE', 'HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE'],
      selectedMaterials: [],
      sessionMcpContext: { v: 1, socketPath: '/tmp/fixture-session.sock', bearerToken: Buffer.alloc(32, 1).toString('base64url') },
    });
    expect(launch.command).toBe('sudo');
    expect(launch.args).toEqual(['-n', '-u', 'happier-agent', '--', '/opt/happier/current/bin/happier', 'agent-launch']);
    expect(launch.env).toEqual({});
    expect(JSON.stringify(launch.args)).not.toContain('selected');
    // Actual stdin is a byte stream; Readable.from defaults to object mode.
    const payload = await readAgentLaunchFrame(Readable.from([launch.stdinPreamble], { objectMode: false }));
    expect(payload.environment).toEqual({ PATH: '/opt/happier/tools:/usr/bin', ANTHROPIC_API_KEY: 'selected',
      HAPPIER_TEST_SELECTED_ACCESS_TOKEN: 'selected-account-token',
      HAPPIER_FIRST_PARTY_INSTALL_HOME: '/opt/happier',
      HAPPIER_MANAGED_TOOLS_ROOT: '/var/lib/happier/tools/personal-install',
      HAPPIER_SESSION_MCP_CONTEXT_FILE: '/home/happier-agent/.local/state/happier/runtime/session/.happier/session-mcp.json' });
    // Explicit selection cannot promote custodian/source credentials into any
    // part of the frame, not merely the child environment projection.
    expect(JSON.stringify(payload)).not.toContain('custodian-token-sentinel');
    expect(JSON.stringify(payload)).not.toContain('source-credential-sentinel');
    expect(JSON.stringify(payload)).not.toContain('host-mcp-config');
  });
});
