export function createTestHomeEnvironment(): Readonly<{
  env: Record<string, string>;
  cleanup: () => void;
}>;
export function assertTestHomePath(homeDir: string, root?: string): void;
export function resolveTestHomeEnvironment(root: string): Record<string, string>;
export function applyTestHomeEnvironment(env: Record<string, string | undefined>, root: string): void;
export function installTestHomeEnvironment(options?: { isolateExecutables?: boolean }): ReturnType<typeof createTestHomeEnvironment>;
