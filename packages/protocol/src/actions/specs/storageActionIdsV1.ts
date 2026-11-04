
/** Action identity leaf: schema modules and the registry share these constants. */
export const MACHINE_STORAGE_ACTION_IDS = [
  'machines.storage.summary.get', 'machines.storage.category.list', 'machines.storage.size.refresh',
  'machines.storage.pile.get', 'machines.storage.pile.set', 'machines.storage.items.check',
  'machines.storage.trash.move', 'machines.storage.deleteNow', 'machines.storage.trash.empty', 'machines.storage.trash.restore',
  'machines.storage.worktrees.list', 'machines.storage.suggestions.list', 'machines.storage.suggestions.decline',
  'machines.storage.scan.start', 'machines.storage.scan.get', 'machines.storage.scan.cancel', 'machines.storage.scan.skip',
  'machines.storage.protected.add', 'machines.storage.protected.remove',
  'machines.storage.docker.prune',
] as const;
