const HOSTED_TOOL_NAME_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export type HostedMcpServerRegistrationValidationOptions = Readonly<{
    pluginId?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNamespacedHostedMcpToolName(value: string): boolean {
    const segments = value.split('.');
    if (segments.some((segment) => !HOSTED_TOOL_NAME_SEGMENT_PATTERN.test(segment))) {
        return false;
    }
    if (segments[0] === 'happier') {
        return segments.length >= 2;
    }
    if (segments[0] === 'ext') {
        return segments.length >= 3;
    }
    return segments.length >= 3;
}

function assertHostedMcpToolName(
    value: unknown,
    path: readonly string[],
    options?: HostedMcpServerRegistrationValidationOptions,
): asserts value is string {
    if (typeof value !== 'string' || !isNamespacedHostedMcpToolName(value)) {
        throw new Error(`Hosted MCP tool name at '${path.join('.')}' must use a canonical namespace`);
    }
    const segments = value.split('.');
    if (options?.pluginId && segments[0] === 'ext' && segments[1] !== options.pluginId) {
        throw new Error(`Hosted MCP tool name at '${path.join('.')}' must use plugin namespace 'ext.${options.pluginId}.*'`);
    }
}

export function assertHostedMcpServerRegistration(
    value: unknown,
    options?: HostedMcpServerRegistrationValidationOptions,
): void {
    if (!isRecord(value) || value.hosted === undefined) {
        return;
    }
    const transport = isRecord(value.transport) ? value.transport : null;
    if (transport?.kind !== 'hosted') {
        throw new Error('Hosted MCP handlers require hosted transport');
    }
    if (!isRecord(value.hosted)) {
        throw new Error("Hosted MCP registration field 'hosted' must be an object");
    }
    const tools = value.hosted.tools;
    if (tools === undefined) {
        return;
    }
    if (!Array.isArray(tools)) {
        throw new Error("Hosted MCP registration field 'hosted.tools' must be an array");
    }
    const seenToolNames = new Set<string>();
    tools.forEach((tool, index) => {
        const path = ['hosted', 'tools', String(index)];
        if (!isRecord(tool)) {
            throw new Error(`Hosted MCP tool at '${path.join('.')}' must be an object`);
        }
        assertHostedMcpToolName(tool.name, [...path, 'name'], options);
        if (seenToolNames.has(tool.name)) {
            throw new Error(`Duplicate hosted MCP tool name '${tool.name}'`);
        }
        seenToolNames.add(tool.name);
        if (typeof tool.handler !== 'function') {
            throw new Error(`Hosted MCP tool '${tool.name}' requires a handler`);
        }
    });
}
