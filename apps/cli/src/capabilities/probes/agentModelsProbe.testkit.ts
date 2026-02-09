import { randomUUID } from 'node:crypto';
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
  return resolve(join(cwd, 'node_modules/@agentclientprotocol/sdk/dist/acp.js'));
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

class FakeAgent {
  connection;
  constructor(connection) {
    this.connection = connection;
  }
  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }
  async newSession() {
    return ${params.sessionPayloadSource};
  }
  async authenticate() { return {}; }
  async prompt() { return { stopReason: "end_turn" }; }
  async cancel() { return {}; }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((conn) => new FakeAgent(conn), stream);
`;

  await writeExecutableScript(agentPath, source);
  return agentPath;
}
