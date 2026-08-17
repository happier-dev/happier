/** @moduleRealm daemon */
export type {
  JsonlByteCursorV1,
  JsonlForwardLineV1,
  JsonlForwardLineV1 as JsonlForwardLine,
  JsonlParsedLineV1,
  JsonlParsedLineV1 as JsonlParsedLine,
  JsonlScannerFileSystemV1,
  JsonlScannerFileSystemV1 as JsonlScannerFileSystem,
  JsonlScanBoundsV1,
  JsonlScanBoundsV1 as JsonlScanBounds,
  JsonlSessionFileDescriptorV1,
  JsonlSessionFileDescriptorV1 as JsonlSessionFileDescriptor,
  JsonlSourceDiagnosticV1,
  JsonlSourceDiagnosticV1 as JsonlSourceDiagnostic,
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
  resolveHomeDirFromEnvironment,
  resolveConfiguredPath,
} from './paths.js';
/** @realm any */
export type { SessionFileStoreHeaderDescriptorV1 as SessionFileStoreHeaderDescriptor } from './productDescriptor.js';
export type {
    SessionFileStoreHeaderDescriptorV1,
    SessionFileStoreProductDescriptorV1,
    SessionFileStoreProductDescriptorV1 as SessionFileStoreProductDescriptor,
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
  SessionFileStoreResolutionInputV1 as SessionFileStoreResolutionInput,
  SessionFileStoreResolutionV1,
  SessionFileStoreResolutionV1 as SessionFileStoreResolution,
} from './sessionDirResolver.js';
export {
  listSessionFileStoreRoots,
  listSessionFileStoreRootsSync,
  resolveSessionFileStoreDirs,
  resolveSessionFileStoreDirsSync,
  resolveSessionFileStoreLaunchEnvironment,
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
