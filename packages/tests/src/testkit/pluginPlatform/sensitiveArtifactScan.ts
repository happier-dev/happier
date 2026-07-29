import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type SensitiveArtifactScanEntry = Readonly<{
  name: string;
  isSymbolicLink: () => boolean;
  isDirectory: () => boolean;
  isFile: () => boolean;
}>;

type SensitiveArtifactScanDeps = Readonly<{
  readdir: (
    path: string,
  ) => Promise<readonly SensitiveArtifactScanEntry[]>;
  readFile: (path: string) => Promise<Buffer>;
}>;

const defaultDeps: SensitiveArtifactScanDeps = {
  readdir: async (path) => await readdir(path, {
    withFileTypes: true,
  }),
  readFile: async (path) => await readFile(path),
};

export async function findSensitiveArtifactFiles(params: Readonly<{
  rootPath: string;
  sensitiveValues: readonly string[];
  strict?: boolean;
  deps?: SensitiveArtifactScanDeps;
}>): Promise<readonly string[]> {
  const deps = params.deps ?? defaultDeps;
  const needles = params.sensitiveValues.map(
    (value) => Buffer.from(value),
  );
  const matches: string[] = [];
  const visit = async (dirPath: string): Promise<void> => {
    let entries: readonly SensitiveArtifactScanEntry[];
    try {
      entries = await deps.readdir(dirPath);
    } catch (error) {
      if (params.strict === true) throw error;
      return;
    }
    for (const entry of entries) {
      const path = join(dirPath, entry.name);
      if (entry.isSymbolicLink()) {
        if (params.strict === true) {
          throw new Error(
            `sensitive_artifact_scan_symlink_rejected:${path}`,
          );
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (
          params.strict !== true
          && (
            entry.name === 'cli-dist'
            || entry.name === 'node_modules'
          )
        ) {
          continue;
        }
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      let bytes: Buffer;
      try {
        bytes = await deps.readFile(path);
      } catch (error) {
        if (params.strict === true) throw error;
        continue;
      }
      if (needles.some((needle) => bytes.includes(needle))) {
        matches.push(path);
      }
    }
  };
  await visit(params.rootPath);
  return matches.sort();
}
