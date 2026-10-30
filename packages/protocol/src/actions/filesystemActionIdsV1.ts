
/** Action identity leaf: schema modules and the registry share these constants. */
export const FILESYSTEM_MUTATION_ACTION_IDS = [
  'daemon.filesystem.createDirectory',
  'daemon.filesystem.rename',
  'daemon.filesystem.delete',
  'daemon.filesystem.copy',
] as const;
export const FILESYSTEM_ACTION_IDS = [
  'daemon.filesystem.readFile',
  'daemon.filesystem.writeFile',
  'daemon.filesystem.listDirectory',
  'daemon.filesystem.getDirectoryTree',
  ...FILESYSTEM_MUTATION_ACTION_IDS,
  'daemon.filesystem.upload',
  'daemon.filesystem.download',
  'daemon.filesystem.transfer.cancel',
] as const;
export const FILESYSTEM_TRANSFER_ACTION_IDS = [
  'daemon.filesystem.upload', 'daemon.filesystem.download', 'daemon.filesystem.transfer.cancel',
] as const;
