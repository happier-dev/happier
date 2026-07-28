import { describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';

import type { TransportHandler } from '@/agent/transport';
import {
  createProbeTempDir,
  resolveAcpSdkEntryFromCwd,
  writeExecutableScript,
} from './agentModelsProbe.testkit';

describe('probeAcpAgentCapabilities extension notifications', () => {
  it('acknowledges initialize-time extension notifications without interpreting provider state', async () => {
    vi.resetModules();

    const fixture = await createProbeTempDir('happier-acp-probe-extension-notification');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const sdkEntry = resolveAcpSdkEntryFromCwd(process.cwd());
      const agentPath = resolve(join(fixture.dir, 'fake-agent.mjs'));
      await writeExecutableScript(
        agentPath,
        `import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

const acp = await import(pathToFileURL(${JSON.stringify(sdkEntry)}).href);

class FakeAgent {
  connection;
  constructor(connection) { this.connection = connection; }
  async initialize() {
    await this.connection.extNotification("vendor.example/initialize-state", {
      nested: { providerOwned: true },
    });
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }
  async newSession() { return { sessionId: "s" }; }
  async authenticate() { return {}; }
  async prompt() { return { stopReason: "end_turn" }; }
  async cancel() { return {}; }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((connection) => new FakeAgent(connection), stream);
`,
      );

      const { probeAcpAgentCapabilities } = await import('./acpProbe');
      const result = await probeAcpAgentCapabilities({
        command: process.execPath,
        args: [agentPath],
        cwd: fixture.dir,
        env: {},
        transport: { agentName: 'extension-notification-test' } as TransportHandler,
        timeoutMs: 2_000,
      });

      expect(result).toMatchObject({
        ok: true,
        agentCapabilities: { loadSession: false },
      });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
      await fixture.cleanup();
    }
  }, 20_000);
});
