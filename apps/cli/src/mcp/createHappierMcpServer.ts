import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { randomUUID } from 'node:crypto';

import { createExecutionRunMcpTools } from '@/mcp/tools/executionRunTools';
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import { logger } from '@/ui/logger';

export const HAPPIER_MCP_TOOL_NAMES = [
  'change_title',
  'execution_run_start',
  'execution_run_list',
  'execution_run_get',
  'execution_run_send',
  'execution_run_stop',
  'execution_run_action',
] as const;

export function createHappierMcpServer(client: HappyMcpSessionClient): { mcp: McpServer; toolNames: string[] } {
  const handler = async (title: string) => {
    logger.debug('[happierMCP] Changing title to:', title);
    try {
      // Send title as a summary message, similar to title generator.
      client.sendClaudeSessionMessage({
        type: 'summary',
        summary: title,
        leafUuid: randomUUID(),
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  };

  const mcp = new McpServer({
    name: 'Happier MCP',
    version: '1.0.0',
  });

  mcp.registerTool(
    'change_title',
    {
      description: 'Change the title of the current chat session',
      title: 'Change Chat Title',
      inputSchema: {
        title: z.string().describe('The new title for the chat session'),
      },
    } as any,
    async (args: any) => {
      const title = typeof args?.title === 'string' ? args.title : '';
      const response = await handler(title);
      logger.debug('[happierMCP] Response:', response);

      if (response.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Successfully changed chat title to: "${title}"`,
            },
          ],
          isError: false as const,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
          },
        ],
        isError: true as const,
      };
    },
  );

  const runTools = createExecutionRunMcpTools({
    sessionId: client.sessionId,
    invokeSessionRpc: async (method, params) => client.rpcHandlerManager.invokeLocal(method, params),
  });

  // Execution run control plane tools
  mcp.registerTool(
    'execution_run_start',
    {
      description: 'Start an execution run (review/plan/delegate/voice agent) in this session',
      title: 'Start Execution Run',
      inputSchema: runTools.execution_run_start.inputSchema,
    } as any,
    async (args: any) => runTools.execution_run_start.handler(args),
  );

  mcp.registerTool(
    'execution_run_list',
    {
      description: 'List execution runs in this session',
      title: 'List Execution Runs',
      inputSchema: runTools.execution_run_list.inputSchema,
    } as any,
    async (args: any) => runTools.execution_run_list.handler(args),
  );

  mcp.registerTool(
    'execution_run_get',
    {
      description: 'Get execution run state (optionally including structured meta)',
      title: 'Get Execution Run',
      inputSchema: runTools.execution_run_get.inputSchema,
    } as any,
    async (args: any) => runTools.execution_run_get.handler(args),
  );

  mcp.registerTool(
    'execution_run_send',
    {
      description: 'Send a message to a long-lived execution run',
      title: 'Send Execution Run Message',
      inputSchema: runTools.execution_run_send.inputSchema,
    } as any,
    async (args: any) => runTools.execution_run_send.handler(args),
  );

  mcp.registerTool(
    'execution_run_stop',
    {
      description: 'Stop a running execution run',
      title: 'Stop Execution Run',
      inputSchema: runTools.execution_run_stop.inputSchema,
    } as any,
    async (args: any) => runTools.execution_run_stop.handler(args),
  );

  mcp.registerTool(
    'execution_run_action',
    {
      description: 'Apply an action to an execution run (e.g. review.triage)',
      title: 'Execution Run Action',
      inputSchema: runTools.execution_run_action.inputSchema,
    } as any,
    async (args: any) => runTools.execution_run_action.handler(args),
  );

  return {
    mcp,
    toolNames: [...HAPPIER_MCP_TOOL_NAMES],
  };
}

