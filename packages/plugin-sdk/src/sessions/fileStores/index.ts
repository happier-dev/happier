export type {
  JsonlByteCursorV1,
  JsonlForwardLineV1,
  JsonlParsedLineV1,
  JsonlScannerFileSystemV1,
  JsonlScanBoundsV1,
  JsonlSessionFileDescriptorV1,
  JsonlSourceDiagnosticV1,
} from './boundedJsonlScanner.js';
export {
  decodeJsonlByteCursor,
  encodeJsonlByteCursor,
  readJsonlFileBackwardPage,
  readJsonlFileForward,
  readJsonlFileForwardLines,
  readJsonlAfterCursor,
  readJsonlRange,
  scanJsonlSessionFile,
} from './boundedJsonlScanner.js';
export { findNewestSessionFileInDir } from './files.js';
export {
  canonicalizePath,
  canonicalizePathSync,
  expandHomePath,
  resolveConfiguredPath,
} from './paths.js';
export type {
  SessionFileStoreHeaderDescriptorV1,
  SessionFileStoreProductDescriptorV1,
} from './productDescriptor.js';
export {
  decodeIndexCursor,
  encodeIndexCursor,
} from './indexCursor.js';
export type { IndexCursorV1 } from './indexCursor.js';
export {
  extractUserMessageText,
  isRecord,
  parseDefaultSessionHeader,
  parseJsonLine,
  parseTimestampMs,
  readString,
  readTrimmedString,
} from './records.js';
export type {
  SessionFileStoreDirSource,
  SessionFileStoreResolutionInputV1,
  SessionFileStoreResolutionV1,
} from './sessionDirResolver.js';
export {
  listSessionFileStoreRoots,
  listSessionFileStoreRootsSync,
  resolveSessionFileStoreDirs,
  resolveSessionFileStoreDirsSync,
} from './sessionDirResolver.js';
export type { SessionFileStoreRootDescriptorV1 } from './sessionRootDescriptor.js';
export { validateSessionFileStoreRootDescriptor } from './sessionRootDescriptor.js';
export {
  isBareSessionFileId,
  parseSessionIdFromFileName,
  readSessionIdFromFileHead,
  sessionFileNameMatchesSessionId,
} from './sessionFileNameCodec.js';
export type {
  TerminalBreadcrumbProjectionContext,
  TerminalBreadcrumbResolver,
  TerminalBreadcrumbResolverConfig,
  TerminalBreadcrumbValidationContext,
} from './terminalBreadcrumbResolver.js';
export { createTerminalBreadcrumbResolver } from './terminalBreadcrumbResolver.js';
