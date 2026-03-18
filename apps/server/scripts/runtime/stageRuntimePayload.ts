import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stageGeneratedClients } from './stageGeneratedClients';
import { stageSqliteMigrations } from './stageSqliteMigrations';
import { writeRuntimePackageJson } from './writeRuntimePackageJson';

type StageRuntimePayloadParams = Readonly<{
  projectDir?: string;
  destRoot: string;
}>;

function resolveDefaultProjectDir(): string {
  return resolve(fileURLToPath(new URL('../..', import.meta.url)));
}

export async function stageServerRuntimePayload({
  projectDir = resolveDefaultProjectDir(),
  destRoot,
}: StageRuntimePayloadParams): Promise<void> {
  await stageGeneratedClients({ projectDir, destRoot });
  await stageSqliteMigrations({ projectDir, destRoot });
  await writeRuntimePackageJson({ projectDir, destRoot });
}

function takeArgValue(argv: string[], name: string): string {
  const direct = argv.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1).trim();
  const index = argv.indexOf(name);
  if (index >= 0) return String(argv[index + 1] ?? '').trim();
  return '';
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === fileURLToPath(import.meta.url);
})();

if (invokedAsMain) {
  const argv = process.argv.slice(2);
  const destRoot = takeArgValue(argv, '--dest-root');
  const projectDir = takeArgValue(argv, '--project-dir');

  if (!destRoot) {
    console.error('[server runtime] missing --dest-root');
    process.exit(1);
  }

  stageServerRuntimePayload({ destRoot, ...(projectDir ? { projectDir } : {}) }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
