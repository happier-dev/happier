import { describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { TransportHandler } from '@/agent/transport';
import { createProbeTempDir, resolveAcpSdkEntryFromCwd, writeExecutableScript } from './agentModelsProbe.testkit';

describe('probeAcpAgentCapabilities (cache)', () => {
  it('caches results and avoids respawning the probe within TTL', async () => {
    vi.resetModules();

    const fixture = await createProbeTempDir('happier-acp-probe-cache');
    const sdkEntry = resolveAcpSdkEntryFromCwd(process.cwd());

    const countFile = resolve(join(fixture.dir, 'count.txt'));
    await writeFile(countFile, '', 'utf8');

    const agentPath = resolve(join(fixture.dir, 'fake-agent.mjs'));
    await writeExecutableScript(
      agentPath,
      `import { Readable, Writable } from "node:stream";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const countFile = process.env.HAPPIER_TEST_ACP_PROBE_COUNT_FILE;
if (countFile) appendFileSync(countFile, "1");

const sdkPath = ${JSON.stringify(sdkEntry)};
const acp = await import(pathToFileURL(sdkPath).href);

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const app = acp.agent({ name: "happier-probe-cache-test-agent" })
  .onRequest("initialize", async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", async () => ({ sessionId: "s" }))
  .onRequest("authenticate", async () => ({}))
  .onRequest("session/prompt", async () => ({ stopReason: "end_turn" }))
  .onNotification("session/cancel", async () => {});
const connection = app.connect(stream);
await connection.closed;
`,
    );

    const { probeAcpAgentCapabilities } = await import('./acpProbe');

    const transport = { agentName: 'fake' } as TransportHandler;
    const base: Parameters<typeof probeAcpAgentCapabilities>[0] = {
      command: process.execPath,
      args: [agentPath],
      cwd: fixture.dir,
      env: { HAPPIER_TEST_ACP_PROBE_COUNT_FILE: countFile },
      transport,
      timeoutMs: 2_000,
    };

    await probeAcpAgentCapabilities(base);
    const afterFirst = (await readFile(countFile, 'utf8')).length;

    await probeAcpAgentCapabilities(base);
    const afterSecond = (await readFile(countFile, 'utf8')).length;

    expect(afterSecond).toBe(afterFirst);
    await fixture.cleanup();
  }, 20_000);
});
