export function describeBackgroundServiceTargetMode(targetMode: string | null | undefined): string {
  if (targetMode === 'default-following') {
    return 'default background service';
  }
  if (targetMode === 'pinned') {
    return 'legacy pinned background service';
  }
  return 'background service';
}
