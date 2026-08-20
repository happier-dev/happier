// Importing a source-built CLI exercises a large module graph, especially on
// Windows and shared development machines. Build admission and stack startup
// must use one budget so a candidate accepted in one path is not rejected by
// the other solely because their clocks disagree.
export const DEFAULT_CLI_RUNTIME_IMPORT_TIMEOUT_MS = 120_000;
