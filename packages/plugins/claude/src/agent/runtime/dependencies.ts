/**
 * Claude-owned logging dependency. The public SDK logger is stricter at its
 * boundary; native bindings sanitize fields before delegating to it. Keeping
 * this package-local shape lets Claude internals report caught Error objects
 * without depending on a legacy host context.
 */
export type ClaudeRuntimeLogger = Readonly<{
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}>;
