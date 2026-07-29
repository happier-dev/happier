import type {
    McpSessionResolutionInput,
    PluginMcpSessionResolver,
    ResolvedSessionMcpServer,
} from '@/mcp/runtimeTypes';

export type CreatePluginMcpSessionResolverParams = Readonly<{
    resolveForSession(
        input: McpSessionResolutionInput,
    ): Promise<readonly ResolvedSessionMcpServer[]> | readonly ResolvedSessionMcpServer[];
}>;

export function createPluginMcpSessionResolver(
    params: CreatePluginMcpSessionResolverParams,
): PluginMcpSessionResolver {
    return Object.freeze({
        async resolveForSession(input) {
            return Object.freeze([...(await params.resolveForSession(input))]);
        },
    });
}
