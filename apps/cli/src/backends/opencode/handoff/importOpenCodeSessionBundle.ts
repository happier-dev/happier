import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { buildOpenCodeSessionEnvironmentVariables } from '../utils/opencodeSessionAffinity';
import { resolveOpenCodeCliCommand } from '../utils/resolveOpenCodeCliCommand';
import type { ImportedSessionHandoffBundle, OpenCodeSessionBundle } from '../../../session/handoff/types';

type ExecFileAsync = (command: string, args: readonly string[]) => Promise<Readonly<{ stdout: string; stderr: string }>>;

const execFileAsync = promisify(execFileCallback) as unknown as ExecFileAsync;

export async function importOpenCodeSessionBundle(params: Readonly<{
  bundle: OpenCodeSessionBundle;
  targetPath: string;
  execFile?: ExecFileAsync;
  sessionStorageMode?: 'direct' | 'persisted';
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<ImportedSessionHandoffBundle> {
  const execFile = params.execFile ?? execFileAsync;
  const tempDir = await mkdtemp(join(tmpdir(), 'handoff-opencode-'));
  const importPath = join(tempDir, `${params.bundle.remoteSessionId}.json`);
  await writeFile(importPath, Buffer.from(params.bundle.exportJsonBase64, 'base64').toString('utf8'), 'utf8');
  await execFile(resolveOpenCodeCliCommand(params.processEnv), ['import', importPath]);

  return {
    remoteSessionId: params.bundle.remoteSessionId,
    directSource: {
      kind: 'opencodeServer',
      baseUrl: params.bundle.affinity.serverBaseUrl,
      directory: params.targetPath,
    },
    resume: {
      directory: params.targetPath,
      agent: 'opencode',
      resume: params.bundle.remoteSessionId,
      environmentVariables: buildOpenCodeSessionEnvironmentVariables({
        backendMode: params.bundle.affinity.backendMode,
        serverBaseUrl: params.bundle.affinity.serverBaseUrlExplicit ? params.bundle.affinity.serverBaseUrl : null,
      }),
      transcriptStorage: params.sessionStorageMode === 'persisted' ? 'persisted' : 'direct',
      approvedNewDirectoryCreation: true,
    },
  };
}
