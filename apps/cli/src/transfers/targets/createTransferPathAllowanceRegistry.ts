export type TransferPathAllowanceRegistry = Readonly<{
  getAdditionalAllowedReadDirs: () => readonly string[];
  getAdditionalAllowedWriteDirs: () => readonly string[];
  setAdditionalAllowedReadDirs: (dirs: readonly string[]) => void;
  setAdditionalAllowedWriteDirs: (dirs: readonly string[]) => void;
}>;

function normalizeDirs(dirs: readonly string[]): string[] {
  return Array.isArray(dirs)
    ? dirs.filter((value) => typeof value === 'string' && value.trim().length > 0)
    : [];
}

export function createTransferPathAllowanceRegistry(params?: Readonly<{
  onReadDirsChange?: (dirs: readonly string[]) => void;
  onWriteDirsChange?: (dirs: readonly string[]) => void;
}>): TransferPathAllowanceRegistry {
  let additionalAllowedReadDirs: string[] = [];
  let additionalAllowedWriteDirs: string[] = [];

  return {
    getAdditionalAllowedReadDirs: () => additionalAllowedReadDirs,
    getAdditionalAllowedWriteDirs: () => additionalAllowedWriteDirs,
    setAdditionalAllowedReadDirs: (dirs) => {
      additionalAllowedReadDirs = normalizeDirs(dirs);
      params?.onReadDirsChange?.(additionalAllowedReadDirs);
    },
    setAdditionalAllowedWriteDirs: (dirs) => {
      additionalAllowedWriteDirs = normalizeDirs(dirs);
      params?.onWriteDirsChange?.(additionalAllowedWriteDirs);
    },
  };
}
