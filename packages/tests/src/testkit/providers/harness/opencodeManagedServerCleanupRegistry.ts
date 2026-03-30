import { stopOpenCodeManagedServerFromHomeDir } from '../opencode/stopOpenCodeManagedServerFromHomeDir';

const registeredHomes = new Set<string>();
let cleanupHandlersInstalled = false;
let cleanupPromise: Promise<void> | null = null;

async function cleanupHomes(homes: readonly string[]): Promise<void> {
  await Promise.all(
    homes.map(async (homeDir) => {
      await stopOpenCodeManagedServerFromHomeDir(homeDir).catch(() => {});
    }),
  );
}

function installCleanupHandlers(): void {
  if (cleanupHandlersInstalled) return;
  cleanupHandlersInstalled = true;

  process.once('beforeExit', () => {
    void cleanupRegisteredOpenCodeManagedServerHomesBestEffort();
  });

  const registerSignalCleanup = (signal: NodeJS.Signals, exitCode: number) => {
    process.once(signal, () => {
      void cleanupRegisteredOpenCodeManagedServerHomesBestEffort().finally(() => {
        process.exit(exitCode);
      });
    });
  };

  registerSignalCleanup('SIGINT', 130);
  registerSignalCleanup('SIGTERM', 143);
}

export function registerOpenCodeManagedServerHomeForCleanup(happyHomeDir: string): () => void {
  const normalizedHomeDir = happyHomeDir.trim();
  if (!normalizedHomeDir) {
    return () => {};
  }

  installCleanupHandlers();
  registeredHomes.add(normalizedHomeDir);

  return () => {
    registeredHomes.delete(normalizedHomeDir);
  };
}

export async function cleanupRegisteredOpenCodeManagedServerHomesBestEffort(): Promise<void> {
  if (cleanupPromise) {
    await cleanupPromise;
    return;
  }

  const homes = [...registeredHomes];
  registeredHomes.clear();
  cleanupPromise = cleanupHomes(homes).finally(() => {
    cleanupPromise = null;
  });
  await cleanupPromise;
}
