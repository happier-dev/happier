import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { TransportHandler } from '@/agent/transport';
import { isPidAlive, waitForProcessExit } from '@/testkit/process/spawn';
import { createProbeTempDir, writeExecutableScript } from './agentModelsProbe.testkit';
import { probeAcpAgentCapabilities } from './acpProbe';

function forceKill(pid: number | undefined): void {
  if (!pid || !isPidAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Defensive cleanup only; the assertion below reports the product failure.
  }
}

describe('probeAcpAgentCapabilities process cleanup', () => {
  it('kills a timed-out provider and its SIGTERM-resistant descendant on POSIX', async () => {
    if (process.platform === 'win32') return;

    const fixture = await createProbeTempDir('happier-acp-probe-process-tree');
    const pidFile = resolve(join(fixture.dir, 'pids.json'));
    const agentPath = resolve(join(fixture.dir, 'sigterm-resistant-agent.mjs'));
    let parentPid: number | undefined;
    let childPid: number | undefined;

    try {
      await writeExecutableScript(
        agentPath,
        `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const childSource = [
  "process.on('SIGTERM', () => {});",
  "setInterval(() => {}, 1000);",
].join("\\n");
const child = spawn(process.execPath, ["-e", childSource], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parentPid: process.pid, childPid: child.pid }));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
      );

      const result = await probeAcpAgentCapabilities({
        command: process.execPath,
        args: [agentPath],
        cwd: fixture.dir,
        env: {},
        transport: { agentName: `process-tree-cleanup-${Date.now()}` } as TransportHandler,
        timeoutMs: 100,
      });

      expect(result).toMatchObject({ ok: false });
      const pids = JSON.parse(await readFile(pidFile, 'utf8')) as {
        parentPid: number;
        childPid: number;
      };
      parentPid = pids.parentPid;
      childPid = pids.childPid;

      await expect(waitForProcessExit(parentPid, { timeoutMs: 2_000 })).resolves.toBe(true);
      await expect(waitForProcessExit(childPid, { timeoutMs: 2_000 })).resolves.toBe(true);
    } finally {
      forceKill(childPid);
      forceKill(parentPid);
      await fixture.cleanup();
    }
  }, 15_000);
});
