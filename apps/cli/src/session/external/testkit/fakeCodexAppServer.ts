import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type FakeCodexAppServerThread = Readonly<{
    id: string;
    cwd?: string;
    createdAt?: number;
    updatedAt?: number;
    name?: string | null;
    preview?: string;
}>;

export async function writeFakeCodexAppServerThreadListScript(params: Readonly<{
    dir: string;
    nonArchivedThreads: readonly FakeCodexAppServerThread[];
    archivedThreads?: readonly FakeCodexAppServerThread[];
}>): Promise<string> {
    const scriptPath = join(params.dir, 'fake-codex-app-server.mjs');
    const nonArchivedThreadsJson = JSON.stringify(params.nonArchivedThreads);
    const archivedThreadsJson = JSON.stringify(params.archivedThreads ?? []);
    await writeFile(scriptPath, `#!/usr/bin/env node
const nonArchivedThreads = ${nonArchivedThreadsJson};
const archivedThreads = ${archivedThreadsJson};
let pending = '';

function writeResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.id === undefined || message.id === null) return;
  if (message.method === 'initialize') {
    writeResponse(message.id, { serverInfo: { name: 'fake-codex-app-server' } });
    return;
  }
  if (message.method === 'thread/list') {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const threads = params.archived === true ? archivedThreads : nonArchivedThreads;
    writeResponse(message.id, { data: threads, nextCursor: null });
    return;
  }
  writeResponse(message.id, null);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  for (;;) {
    const index = pending.indexOf('\\n');
    if (index === -1) break;
    const line = pending.slice(0, index).trim();
    pending = pending.slice(index + 1);
    if (!line) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch {
      // Test helper: malformed frames are ignored so the caller times out with its normal diagnostics.
    }
  }
});
`, 'utf8');
    await chmod(scriptPath, 0o755);
    return scriptPath;
}
