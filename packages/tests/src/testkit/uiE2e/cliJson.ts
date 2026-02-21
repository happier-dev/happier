import { readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

import { ensureCliDistBuilt } from '../process/cliDist';
import { runLoggedCommand } from '../process/spawnProcess';
import { repoRootDir } from '../paths';

export type JsonEnvelope = {
  ok: boolean;
  kind: string;
  data?: unknown;
  error?: unknown;
};

function pickLastJsonEnvelope(text: string): JsonEnvelope {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    if (!(line.startsWith('{') || line.startsWith('['))) continue;
    try {
      const parsed = JSON.parse(line) as JsonEnvelope;
      if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean' && typeof parsed.kind === 'string') {
        return parsed;
      }
    } catch {
      // keep scanning backwards
    }
  }
  throw new Error(`Failed to parse JSON envelope from CLI stdout: ${JSON.stringify(lines.slice(-20).join('\n'))}`);
}

export async function runCliJson(params: Readonly<{
  testDir: string;
  cliHomeDir: string;
  serverUrl: string;
  webappUrl: string;
  env: NodeJS.ProcessEnv;
  label: string;
  args: string[];
  timeoutMs?: number;
}>): Promise<JsonEnvelope> {
  const cliDistEntrypoint = await ensureCliDistBuilt({ testDir: params.testDir, env: params.env });
  const stdoutPath = resolvePath(join(params.testDir, `cli.${params.label}.stdout.log`));
  const stderrPath = resolvePath(join(params.testDir, `cli.${params.label}.stderr.log`));

  await runLoggedCommand({
    command: process.execPath,
    args: [cliDistEntrypoint, ...params.args],
    cwd: repoRootDir(),
    env: {
      ...params.env,
      CI: '1',
      HAPPIER_SESSION_AUTOSTART_DAEMON: '0',
      HAPPIER_HOME_DIR: params.cliHomeDir,
      HAPPIER_SERVER_URL: params.serverUrl,
      HAPPIER_WEBAPP_URL: params.webappUrl,
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_VARIANT: 'dev',
    },
    stdoutPath,
    stderrPath,
    timeoutMs: params.timeoutMs,
  });

  const stdoutText = await readFile(stdoutPath, 'utf8').catch(() => '');
  return pickLastJsonEnvelope(stdoutText);
}

