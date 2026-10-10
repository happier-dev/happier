export type PortableArchiveLimits = Readonly<{
  maxEntries: number | null;
  maxFiles: number | null;
  maxFileBytes: number | null;
  maxExpandedBytes: number | null;
  maxPathBytes: number | null;
  maxPathDepth: number | null;
  maxCompressionRatio: number | null;
}>;

export const DEFAULT_PORTABLE_ARCHIVE_LIMITS: PortableArchiveLimits = Object.freeze({
  maxEntries: null,
  maxFiles: null,
  maxFileBytes: null,
  maxExpandedBytes: null,
  maxPathBytes: null,
  maxPathDepth: null,
  maxCompressionRatio: null,
});

export type PortableArchiveFile = Readonly<{
  path: string;
  byteLength: number;
  digest: `sha256:${string}`;
}>;

export type ExtractedPortableArchive = Readonly<{
  rootPath: string;
  inventory: readonly PortableArchiveFile[];
}>;

export type PortableArchiveErrorCode =
  | 'archive_source_invalid'
  | 'archive_integrity_invalid'
  | 'archive_integrity_mismatch'
  | 'archive_format_invalid'
  | 'archive_root_invalid'
  | 'archive_path_invalid'
  | 'archive_path_collision'
  | 'archive_entry_type_unsupported'
  | 'archive_limit_entries'
  | 'archive_limit_files'
  | 'archive_limit_file_bytes'
  | 'archive_limit_expanded_bytes'
  | 'archive_limit_path_bytes'
  | 'archive_limit_path_depth'
  | 'archive_limit_compression_ratio'
  | 'archive_aborted';

export class PortableArchiveError extends Error {
  readonly code: PortableArchiveErrorCode;

  constructor(code: PortableArchiveErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PortableArchiveError';
    this.code = code;
  }
}
