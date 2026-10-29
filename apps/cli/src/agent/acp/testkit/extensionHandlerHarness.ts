type ExtensionContext = Readonly<{ params: unknown; signal: AbortSignal }>;

/** Mirror the SDK boundary: registered parsers run before descriptor callbacks. */
export function withParsedAcpExtensionHandler(
  parser: unknown,
  handler: ((context: Readonly<{ params: Record<string, unknown>; signal: AbortSignal }>) => unknown) | null,
): (context: ExtensionContext) => unknown {
  if (!handler) throw new Error('ACP extension callback was not registered');
  return (context) => {
    const parsed: unknown = typeof parser === 'function'
      ? parser(context.params)
      : parser && typeof parser === 'object' && 'parse' in parser && typeof parser.parse === 'function'
        ? parser.parse(context.params)
        : undefined;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('ACP extension params parser did not return an object');
    }
    return handler({ ...context, params: parsed as Record<string, unknown> });
  };
}
