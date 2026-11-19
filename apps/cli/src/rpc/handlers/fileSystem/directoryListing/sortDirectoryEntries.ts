import type { DirectoryListingEntry } from './directoryListingTypes'

function normalizeName(name: string): string {
  return name.normalize('NFKC')
}

export function sortDirectoryEntries<T extends DirectoryListingEntry>(entries: readonly T[]): T[] {
  // Reuse ICU comparison state for this listing rather than rebuilding it for
  // every comparison in a large directory's sort.
  const compareNames = new Intl.Collator(undefined, { sensitivity: 'base' }).compare
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) {
      if (left.type === 'directory') return -1
      if (right.type === 'directory') return 1
    }
    return compareNames(normalizeName(left.name), normalizeName(right.name))
  })
}
