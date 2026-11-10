/** Preserve the host schema when a realtime provider cannot compile it directly. */
export function describeVoiceToolJsonArguments(schema: Readonly<Record<string, unknown>>): string {
    return `A JSON-encoded argument object matching this JSON Schema: ${JSON.stringify(schema)}`;
}

/** Retained provider configurations may still send native argument objects. */
export function decodeVoiceToolJsonArguments(parameters: unknown): unknown {
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return parameters;
    const record = parameters as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || typeof record.arguments_json !== 'string') return parameters;
    try { return JSON.parse(record.arguments_json); } catch { return null; }
}
