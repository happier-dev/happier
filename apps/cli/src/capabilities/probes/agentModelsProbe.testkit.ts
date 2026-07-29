import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export async function createProbeTempDir(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = resolve(join(tmpdir(), `${prefix}-${randomUUID()}`));
  await mkdir(dir, { recursive: true });
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function resolveAcpSdkEntryFromCwd(cwd: string): string {
  const requireFromHere = createRequire(import.meta.url);
  return requireFromHere.resolve('@agentclientprotocol/sdk', { paths: [cwd] });
}

export async function writeExecutableScript(filePath: string, source: string): Promise<void> {
  await writeFile(filePath, source, 'utf8');
  await chmod(filePath, 0o755);
}

export async function writeFakeAcpAgentScript(params: {
  dir: string;
  sdkEntry: string;
  sessionPayloadSource: string;
}): Promise<string> {
  const agentPath = resolve(join(params.dir, 'fake-agent.mjs'));
  const source = `import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const sdkPath = ${JSON.stringify(params.sdkEntry)};
const acp = await import(pathToFileURL(sdkPath).href);

const app = acp.agent({ name: "happier-test-agent" })
  .onRequest("initialize", async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", async () => (${params.sessionPayloadSource}))
  .onRequest("authenticate", async () => ({}))
  .onRequest("session/prompt", async () => ({ stopReason: "end_turn" }))
  .onNotification("session/cancel", async () => {});

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = app.connect(stream);
await connection.closed;
`;

  await writeExecutableScript(agentPath, source);
  return agentPath;
}
