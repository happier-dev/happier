export const OPEN_CODE_IMPORT_EXPORT_JSON_MAX_BYTES = 8 * 1024 * 1024;

// Node's default execFile maxBuffer is too small for realistic OpenCode export payloads.
// Keep this comfortably above OPEN_CODE_IMPORT_EXPORT_JSON_MAX_BYTES so we can surface a
// deterministic "exceeds size limit" error instead of an OS-level maxBuffer failure.
export const OPEN_CODE_EXPORT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
