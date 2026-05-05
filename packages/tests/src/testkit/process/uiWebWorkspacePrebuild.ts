import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoRootDir } from '../paths';
import { runLoggedCommand } from './spawnProcess';

export async function ensureUiWebWorkspacePrebuild(params: {
  testDir: string;
  env: NodeJS.ProcessEnv;
  workspaceRootDir: string;
  logPrefix: string;
  timeoutMs: number;
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

  const timeoutError = new Error(
    `workspace build preflight timed out after ${params.timeoutMs}ms while ensuring ${params.workspaceRootDir} workspace packages were built`,
  );

  try {
    const stacksPmModuleUrl = pathToFileURL(resolvePath(repoRootDir(), 'apps', 'stack', 'scripts', 'utils', 'proc', 'pm.mjs')).href;
    const launchEnv: NodeJS.ProcessEnv = {
      ...params.env,
      CI: '1',
      // Make lock waits show up promptly in prebuild logs (helps distinguish "hung" vs "waiting").
      HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: String(params.env.HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS ?? 1_000),
      HAPPIER_WORKSPACE_BUILD_NOTICE_EVERY_MS: String(params.env.HAPPIER_WORKSPACE_BUILD_NOTICE_EVERY_MS ?? 10_000),
    };

    // Run workspace prebuild in a subprocess so timeouts can kill the build process tree rather
    // than leaving an in-process promise running and holding locks.
    await runLoggedCommand({
      command: process.execPath,
      args: [
        '--input-type=module',
        '--eval',
        [
          "import { resolve } from 'node:path';",
          `const stacksUrl = ${JSON.stringify(stacksPmModuleUrl)};`,
          'const { ensureWorkspacePackagesBuiltForComponent } = await import(stacksUrl);',
          'const workspaceRootDir = process.argv[1];',
          "if (!workspaceRootDir) throw new Error('missing workspaceRootDir');",
          'const res = await ensureWorkspacePackagesBuiltForComponent(resolve(workspaceRootDir), { quiet: false, env: process.env });',
          'process.stdout.write(`${JSON.stringify(res)}\\n`);',
        ].join('\n'),
        params.workspaceRootDir,
      ],
      cwd: repoRootDir(),
      env: launchEnv,
      stdoutPath: prebuildStdoutPath,
      stderrPath: prebuildStderrPath,
      timeoutMs: params.timeoutMs,
    });
    await appendFile(
      params.stderrPath,
      `[${params.logPrefix}] workspace build preflight completed: ${params.workspaceRootDir}\n`,
    ).catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const normalizedError = message.includes('timed out after') ? timeoutError : (error instanceof Error ? error : new Error(message));
    await appendFile(
      params.stderrPath,
      `[${params.logPrefix}] workspace build preflight failed: ${normalizedError.message}\n` +
        `[${params.logPrefix}] workspace build preflight logs: ${prebuildStdoutPath} ${prebuildStderrPath}\n`,
    ).catch(() => {});
    throw normalizedError;
  }
}

export function isUiWebWorkspacePrebuildTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('workspace build preflight timed out after ');
}

export function isUiWebWorkspacePrebuildSharedCliDistBuildLockActiveError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('shared CLI dist build lock is active: ');
}
