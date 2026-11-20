import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import { sourceBuildNodeArgs } from '../../../../../apps/stack/scripts/utils/proc/sourceBuildNodeArgs.mjs';
import { repoRootDir } from '../paths';
import { runLoggedCommand } from './spawnProcess';

export async function ensureUiWebWorkspacePrebuild(params: {
  testDir: string;
  env: NodeJS.ProcessEnv;
  workspaceRootDir: string;
  logPrefix: string;
  stdoutPath: string;
  stderrPath: string;
  prebuildStdoutPath?: string;
  prebuildStderrPath?: string;
}): Promise<void> {
  const prebuildStdoutPath = params.prebuildStdoutPath ?? resolvePath(params.testDir, 'ui.web.prebuild.stdout.log');
  const prebuildStderrPath = params.prebuildStderrPath ?? resolvePath(params.testDir, 'ui.web.prebuild.stderr.log');

  await mkdir(params.testDir, { recursive: true });
  await Promise.all([
    writeFile(params.stdoutPath, '', 'utf8').catch(() => {}),
    writeFile(params.stderrPath, '', 'utf8').catch(() => {}),
    writeFile(prebuildStdoutPath, '', 'utf8').catch(() => {}),
    writeFile(prebuildStderrPath, '', 'utf8').catch(() => {}),
  ]);
  await appendFile(
    params.stderrPath,
    `[${params.logPrefix}] workspace build preflight started: ${params.workspaceRootDir}\n`,
  ).catch(() => {});

  try {
    const repoDir = repoRootDir();
    const uiWorkspaceBuildModuleUrl = pathToFileURL(
      resolvePath(repoDir, 'apps', 'ui', 'scripts', 'ensureWorkspacePackagesBuilt.mjs'),
    ).href;
    const launchEnv: NodeJS.ProcessEnv = {
      ...params.env,
      CI: '1',
      // Make lock waits show up promptly in prebuild logs (helps distinguish "hung" vs "waiting").
      HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: String(params.env.HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS ?? 1_000),
      HAPPIER_WORKSPACE_BUILD_NOTICE_EVERY_MS: String(params.env.HAPPIER_WORKSPACE_BUILD_NOTICE_EVERY_MS ?? 10_000),
    };

    // Admission and build completion belong to the workspace publisher. A local
    // phase deadline would kill healthy builds while they wait for admission.
    await runLoggedCommand({
      command: process.execPath,
      args: sourceBuildNodeArgs({
        repoDir,
        scriptPath: '--input-type=module',
        args: [
          '--eval',
          [
            `const uiWorkspaceBuildModuleUrl = ${JSON.stringify(uiWorkspaceBuildModuleUrl)};`,
            'const { ensureUiWorkspacePackagesBuilt } = await import(uiWorkspaceBuildModuleUrl);',
            'const uiPackageDir = process.argv[1];',
            "if (!uiPackageDir) throw new Error('missing uiPackageDir');",
            'const res = await ensureUiWorkspacePackagesBuilt({ uiPackageDir, env: process.env });',
            'process.stdout.write(`${JSON.stringify(res)}\\n`);',
          ].join('\n'),
          params.workspaceRootDir,
        ],
      }),
      cwd: repoDir,
      env: launchEnv,
      stdoutPath: prebuildStdoutPath,
      stderrPath: prebuildStderrPath,
      timeoutMs: null,
      // The launcher's placement/admission progress belongs on the caller's console:
      // otherwise a queued nested publisher looks like a hung test.
      echoStderrLine: (line) => line.startsWith('[preferred-execution] '),
    });
    await appendFile(
      params.stderrPath,
      `[${params.logPrefix}] workspace build preflight completed: ${params.workspaceRootDir}\n`,
    ).catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const normalizedError = error instanceof Error ? error : new Error(message);
    await appendFile(
      params.stderrPath,
      `[${params.logPrefix}] workspace build preflight failed: ${normalizedError.message}\n` +
        `[${params.logPrefix}] workspace build preflight logs: ${prebuildStdoutPath} ${prebuildStderrPath}\n`,
    ).catch(() => {});
    throw normalizedError;
  }
}

export function isUiWebWorkspacePrebuildSharedCliDistBuildLockActiveError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('shared CLI dist build lock is active: ');
}
