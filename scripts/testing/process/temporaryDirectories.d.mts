export function createTestTempDirectory(prefix: string, parentDirectory?: string): Readonly<{
  root: string;
  cleanup: () => void;
}>;
