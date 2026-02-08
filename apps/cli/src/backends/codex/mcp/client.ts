import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { logger } from '@/ui/logger';

import { getCodexMcpCommand, getCodexVersionInfo } from './version';

export type CodexMcpClientSpawnMode = 'codex-cli' | 'mcp-server';

export function createCodexTransport(params: {
    codexCommand: string;
    mode: CodexMcpClientSpawnMode;
    mcpServerArgs: string[];
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
            throw new Error(
                `Codex CLI not found or not executable: ${params.codexCommand}\n` +
                '\n' +
                'To install codex:\n' +
                '  npm install -g @openai/codex\n' +
                '\n' +
                'Alternatively, use Claude:\n' +
                '  happy claude'
            );
        }

        const mcpCommand = getCodexMcpCommand(params.codexCommand);
        logger.debug(`[CodexMCP] Connecting to Codex MCP server using command: ${params.codexCommand} ${mcpCommand}`);
        return [mcpCommand];
    })();

    const transport = new StdioClientTransport({
        command: params.codexCommand,
        args: transportArgs,
        env: Object.keys(process.env).reduce((acc, key) => {
            const value = process.env[key];
            if (typeof value === 'string') acc[key] = value;
            return acc;
        }, {} as Record<string, string>)
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
