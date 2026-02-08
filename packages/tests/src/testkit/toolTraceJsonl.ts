export type ToolTraceEventV1 = {
  v: number;
  direction?: string;
  sessionId?: string;
  protocol?: string;
  provider?: string;
  kind?: string;
  payload?: any;
};

export function parseToolTraceJsonl(raw: string): ToolTraceEventV1[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ToolTraceEventV1];
      } catch {
        return [];
      }
    });
}

export function hasToolCall(
  events: ToolTraceEventV1[],
  params: { protocol: string; name: string; commandSubstring?: string },
): boolean {
  return events.some((event) => {
    if (event.protocol !== params.protocol) return false;
    if (event.kind !== 'tool-call') return false;
    const payload = event.payload;
    if (!payload || payload.name !== params.name) return false;
    if (!params.commandSubstring) return true;
    return typeof payload.input?.command === 'string'
      && payload.input.command.includes(params.commandSubstring);
  });
}
