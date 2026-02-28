import { join } from 'node:path';

import { getProjectPath } from '@/backends/claude/utils/path';
import type { EnhancedMode } from '@/backends/claude/loop';
import type { PermissionResult } from '@/backends/claude/sdk/types';

const BASH_SECRET_SCRUB_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SETUP_TOKEN',
] as const;

function toAgentSdkPermissionResult(result: PermissionResult): any {
  if (result.behavior === 'allow') {
    return {
      behavior: 'allow',
      updatedInput: result.updatedInput,
    };
  }

  return {
    behavior: 'deny',
    message: result.message,
    ...(result.interrupt !== undefined ? { interrupt: result.interrupt } : {}),
  };
}

export function buildClaudeAgentSdkHooks(params: Readonly<{
  cwd: string;
  claudeConfigDir: string | null;
  getMode: () => EnhancedMode;
  onSessionFound: (sessionId: string, data: { transcript_path: string; transcriptPath: string }) => void;
  canCallTool: (
    toolName: string,
    input: unknown,
    mode: EnhancedMode,
    options: {
      signal: AbortSignal;
      toolUseId?: string | null;
      agentId?: string | null;
      suggestions?: unknown;
      blockedPath?: string | null;
      decisionReason?: string | null;
    },
  ) => Promise<PermissionResult>;
}>): Readonly<{
  hooks: Record<string, unknown>;
  canUseTool: (toolName: string, input: Record<string, unknown>, options: any) => Promise<any>;
}> {
  const hooks = {
    SessionStart: [
      {
        hooks: [
          async (input: any) => {
            const sessionId =
              input && typeof input.session_id === 'string'
                ? input.session_id
                : input && typeof input.sessionId === 'string'
                  ? input.sessionId
                  : undefined;
            if (sessionId) {
              const transcriptRaw =
                typeof input.transcript_path === 'string'
                  ? input.transcript_path
                  : typeof input.transcriptPath === 'string'
                    ? input.transcriptPath
                    : undefined;
              const transcriptPathFallback =
                transcriptRaw ?? join(getProjectPath(params.cwd, params.claudeConfigDir), `${sessionId}.jsonl`);
              params.onSessionFound(sessionId, { transcript_path: transcriptPathFallback, transcriptPath: transcriptPathFallback });
            }
            return { continue: true };
          },
        ],
      },
    ],
    PreToolUse: [
      {
        hooks: [
          async (input: any) => {
            if (!input || typeof input !== 'object') {
              return { continue: true, suppressOutput: true };
            }

            const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
            if (toolName !== 'Bash') {
              return { continue: true, suppressOutput: true };
            }

            const toolInput = (input as any).tool_input;
            if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
              return { continue: true, suppressOutput: true };
            }

            const command = typeof (toolInput as any).command === 'string' ? (toolInput as any).command : '';
            if (!command.trim()) {
              return { continue: true, suppressOutput: true };
            }

            const prefix = `unset ${BASH_SECRET_SCRUB_ENV_KEYS.join(' ')}; `;
            const nextCommand = command.startsWith(prefix) ? command : prefix + command;

            return {
              continue: true,
              suppressOutput: true,
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                updatedInput: {
                  ...(toolInput as Record<string, unknown>),
                  command: nextCommand,
                },
              },
            };
          },
        ],
      },
    ],
    PermissionRequest: [
      {
        hooks: [
          async (input: any, toolUseID: string | undefined, options: { signal: AbortSignal }) => {
            if (!input || typeof input !== 'object') {
              return { continue: true, suppressOutput: true };
            }
            const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
            const toolInput = (input as any).tool_input;
            if (!toolName) {
              return { continue: true, suppressOutput: true };
            }

            const result = await params.canCallTool(toolName, toolInput, params.getMode(), {
              signal: options.signal,
              toolUseId: typeof toolUseID === 'string' ? toolUseID : null,
              suggestions: (input as any).permission_suggestions,
            });

            if (result.behavior === 'allow') {
              const updatedInput =
                result.updatedInput && typeof result.updatedInput === 'object' && !Array.isArray(result.updatedInput)
                  ? (result.updatedInput as Record<string, unknown>)
                  : undefined;
              return {
                continue: true,
                suppressOutput: true,
                hookSpecificOutput: {
                  hookEventName: 'PermissionRequest',
                  decision: {
                    behavior: 'allow',
                    ...(updatedInput ? { updatedInput } : {}),
                  },
                },
              };
            }

            return {
              continue: true,
              suppressOutput: true,
              hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: {
                  behavior: 'deny',
                  ...(typeof result.message === 'string' && result.message.length > 0 ? { message: result.message } : {}),
                  ...(result.interrupt !== undefined ? { interrupt: result.interrupt } : {}),
                },
              },
            };
          },
        ],
      },
    ],
  };

  const canUseTool = async (toolName: string, input: Record<string, unknown>, options: any) => {
    const result = await params.canCallTool(toolName, input, params.getMode(), {
      signal: options.signal,
      toolUseId: typeof options?.toolUseID === 'string' ? options.toolUseID : null,
      agentId: typeof options?.agentID === 'string' ? options.agentID : null,
      suggestions: options?.suggestions,
      blockedPath: typeof options?.blockedPath === 'string' ? options.blockedPath : null,
      decisionReason: typeof options?.decisionReason === 'string' ? options.decisionReason : null,
    });
    return toAgentSdkPermissionResult(result);
  };

  return { hooks, canUseTool };
}
