import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RuntimeSnapshotFixture = {
  root: string;
  storageDir: string;
  stackDir: string;
  stackName: string;
  snapshotDir: string;
  cliHomeDir: string;
  serverPort: number;
  baseUrl: string;
};

type RuntimeSnapshotFixtureModule = {
  createStartableRuntimeSnapshotFixture: (
    testContext: { after: (callback: () => void | Promise<void>) => void },
    options?: { stackName?: string; serverPort?: number },
  ) => Promise<RuntimeSnapshotFixture>;
  runNode: (
    args: string[],
    options: { cwd: string; env: Record<string, string | undefined> },
  ) => Promise<{ code: number; signal: string | null; stdout: string; stderr: string }>;
  waitForHealth: (
    baseUrl: string,
    options?: { timeoutMs?: number; intervalMs?: number },
  ) => Promise<void>;
};

export function getRepoRootFromMeta(metaUrl: string): string {
  const filePath = fileURLToPath(metaUrl);
  return resolve(dirname(filePath), '../../../..');
}

async function loadRuntimeSnapshotFixtureModule(): Promise<RuntimeSnapshotFixtureModule> {
  const modulePath = ['..', '..', '..', '..', 'apps', 'stack', 'scripts', 'testkit', 'runtime_snapshot_start_testkit.mjs'].join('/');
  return (await import(modulePath)) as RuntimeSnapshotFixtureModule;
}

export async function createRuntimeSnapshotFixture(
  testContext: { after: (callback: () => void | Promise<void>) => void },
  options?: Parameters<RuntimeSnapshotFixtureModule['createStartableRuntimeSnapshotFixture']>[1],
): Promise<RuntimeSnapshotFixture> {
  const mod = await loadRuntimeSnapshotFixtureModule();
  return await mod.createStartableRuntimeSnapshotFixture(testContext, options);
}

export async function runNodeCommand(
  args: string[],
  options: Parameters<RuntimeSnapshotFixtureModule['runNode']>[1],
) {
  const mod = await loadRuntimeSnapshotFixtureModule();
  return await mod.runNode(args, options);
}

export async function waitForRuntimeHealth(
  baseUrl: string,
  options?: Parameters<RuntimeSnapshotFixtureModule['waitForHealth']>[1],
): Promise<void> {
  const mod = await loadRuntimeSnapshotFixtureModule();
  await mod.waitForHealth(baseUrl, options);
}

export function createStackRuntimeEnv(fixture: RuntimeSnapshotFixture) {
  return {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
  };
}
