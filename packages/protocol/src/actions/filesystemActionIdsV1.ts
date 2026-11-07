
/** Action identity leaf: schema modules and the registry share these constants. */
export const FILESYSTEM_BROWSER_ACTION_IDS_V1 = {
  listRoots: 'daemon.filesystem.listRoots',
  browseDirectory: 'daemon.filesystem.browseDirectory',
  listFiles: 'daemon.filesystem.listFiles',
} as const;
export const FILESYSTEM_MUTATION_ACTION_IDS = [
  'daemon.filesystem.createDirectory',
  'daemon.filesystem.rename',
  'daemon.filesystem.delete',
  'daemon.filesystem.copy',
] as const;
export const FILESYSTEM_EFFECT_ACTION_IDS = [
  ...Object.values(FILESYSTEM_BROWSER_ACTION_IDS_V1),
  'daemon.filesystem.readFile',
  'daemon.filesystem.writeFile',
  'daemon.filesystem.listDirectory',
  'daemon.filesystem.getDirectoryTree',
  ...FILESYSTEM_MUTATION_ACTION_IDS,
] as const;
export const FILESYSTEM_ACTION_IDS = [
  ...FILESYSTEM_EFFECT_ACTION_IDS,
  'daemon.filesystem.upload',
  'daemon.filesystem.download',
  'daemon.filesystem.transfer.cancel',
] as const;
export const FILESYSTEM_TRANSFER_ACTION_IDS = [
  'daemon.filesystem.upload', 'daemon.filesystem.download', 'daemon.filesystem.transfer.cancel',
] as const;
