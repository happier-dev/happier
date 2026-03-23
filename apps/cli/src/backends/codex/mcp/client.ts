import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { logger } from '@/ui/logger';
import { buildProviderCliUnavailableMessage } from '@/runtime/managedTools/buildProviderCliUnavailableMessage';

import { getCodexMcpCommand, getCodexVersionInfo } from './version';

export type CodexMcpClientSpawnMode = 'codex-cli' | 'mcp-server';

export function createCodexTransport(params: {
    codexCommand: string;
    mode: CodexMcpClientSpawnMode;
    mcpServerArgs: string[];
    env?: NodeJS.ProcessEnv;
}): {
    transport: StdioClientTransport;
    versionInfo: ReturnType<typeof getCodexVersionInfo>;
} {
    const detectedVersionInfo = params.mode === 'mcp-server' ? null : getCodexVersionInfo(params.codexCommand);
    const transportArgs = (() => {
        if (params.mode === 'mcp-server') {
            logger.debug(`[CodexMCP] Connecting to MCP server using command: ${params.codexCommand} ${params.mcpServerArgs.join(' ')}`.trim());
            return params.mcpServerArgs;
        }

        logger.debug('[CodexMCP] Detected codex version', detectedVersionInfo);

        if (!detectedVersionInfo || detectedVersionInfo.raw === null) {
            throw new Error(buildProviderCliUnavailableMessage({
                agentId: 'codex',
                resolvedCommand: params.codexCommand,
                alternativeCommandHint: ['Alternatively, use Claude:', '  happier claude'].join('\n'),
            }));
        }

        const mcpCommand = getCodexMcpCommand(params.codexCommand);
        logger.debug(`[CodexMCP] Connecting to Codex MCP server using command: ${params.codexCommand} ${mcpCommand}`);
        return [mcpCommand];
    })();

    const env = Object.keys(process.env).reduce((acc, key) => {
        const value = process.env[key];
        if (typeof value === 'string') acc[key] = value;
        return acc;
    }, {} as Record<string, string>);
    for (const [key, value] of Object.entries(params.env ?? {})) {
        if (typeof value === 'string') {
            env[key] = value;
            continue;
        }
        delete env[key];
    }

    const transport = new StdioClientTransport({
        command: params.codexCommand,
        args: transportArgs,
        env,
    });

    const versionInfo = params.mode === 'mcp-server'
        ? {
            raw: null,
            parsed: false,
            major: 0,
            minor: 0,
            patch: 0,
        }
        : detectedVersionInfo!;

    return { transport, versionInfo };
}
