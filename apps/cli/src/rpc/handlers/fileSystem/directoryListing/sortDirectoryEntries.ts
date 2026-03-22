import type { DirectoryListingEntry } from './directoryListingTypes'

function normalizeName(name: string): string {
  return name.normalize('NFKC')
}

export function sortDirectoryEntries(entries: readonly DirectoryListingEntry[]): DirectoryListingEntry[] {
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) {
      if (left.type === 'directory') return -1
      if (right.type === 'directory') return 1
    }
    return normalizeName(left.name).localeCompare(normalizeName(right.name), undefined, { sensitivity: 'base' })
  })
}
