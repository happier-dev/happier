import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export type AgentNativeHomeReadService = Readonly<{
  root: string;
  readFiles(fileIds: readonly string[]): Promise<Readonly<Record<string, Uint8Array>>>;
}>;

function resolveDeclaredPath(root: string, fileId: string): string {
  const resolvedRoot = resolve(root);
  const path = resolve(join(resolvedRoot, fileId));
  const relativePath = relative(resolvedRoot, path);
  if (
    !fileId
    || fileId.includes('\\')
    || relativePath.length === 0
    || relativePath.startsWith('..')
    || isAbsolute(relativePath)
  ) {
    throw new Error('connected_service_native_home_credential_path_unsafe');
  }
  return path;
}

export function createAgentNativeHomeReadService(input: Readonly<{
  root: string;
  declaredFileIds: readonly string[];
}>): AgentNativeHomeReadService | null {
  if (input.declaredFileIds.length === 0) return null;
  const declaredFileIdSet = new Set(input.declaredFileIds);
  return Object.freeze({
    root: input.root,
    async readFiles(fileIds) {
      const files: Record<string, Uint8Array> = Object.create(null);
      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(input.root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze(files);
        throw error;
      }
      for (const fileId of fileIds) {
        if (!declaredFileIdSet.has(fileId)) {
          throw new Error('connected_service_native_home_credential_file_undeclared');
        }
        try {
          const canonicalPath = await realpath(resolveDeclaredPath(input.root, fileId));
          const relativePath = relative(canonicalRoot, canonicalPath);
          if (
            relativePath.length === 0
            || relativePath.startsWith('..')
            || isAbsolute(relativePath)
          ) {
            throw new Error('connected_service_native_home_credential_path_unsafe');
          }
          files[fileId] = new Uint8Array(await readFile(canonicalPath));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      return Object.freeze(files);
    },
  });
}
