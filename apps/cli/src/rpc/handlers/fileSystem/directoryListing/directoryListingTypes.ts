export type DirectoryListingEntryType = 'file' | 'directory' | 'other'

export type DirectoryListingEntry = Readonly<{
  name: string
  absolutePath: string
  type: DirectoryListingEntryType
  size?: number
  modified?: number
}>

export type DirectoryListingResult = Readonly<{
  entries: DirectoryListingEntry[]
  truncated: boolean
}>
