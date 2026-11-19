import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ErrorCode, McpError, type ProgressNotification, type RequestMeta } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '@/ui/logger';

type BridgeRequestExtra = Readonly<{
  signal?: AbortSignal;
  _meta?: RequestMeta;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}>;

export type HappierBridgeCallOptions = Readonly<{
  signal?: AbortSignal;
  requestMetadata?: RequestMeta;
  onprogress?: RequestOptions['onprogress'];
}>;

export type HappierBridgeToolCaller = (
  name: string,
  args: unknown,
  options?: HappierBridgeCallOptions,
) => ReturnType<Client['callTool']>;

export function forwardHappierBridgeTool(
  name: string,
  args: unknown,
  extra: BridgeRequestExtra | undefined,
  callHttpTool: HappierBridgeToolCaller,
) {
  return forwardTool(name, callHttpTool)(args, extra);
}

function forwardTool(name: string, callHttpTool: HappierBridgeToolCaller) {
  return async (args: unknown, extra?: BridgeRequestExtra) => {
    const progressToken = extra?._meta?.progressToken;
    const pendingProgressNotifications: Promise<void>[] = [];
    const onprogress = (
      (typeof progressToken === 'string' || typeof progressToken === 'number')
      && typeof extra?.sendNotification === 'function'
    )
      ? (progress: Readonly<{ progress: number; total?: number; message?: string }>) => {
        const notification = extra.sendNotification?.({
          method: 'notifications/progress',
          params: { ...progress, progressToken },
        }).catch((error) => {
          logger.debug('[happierMCP] Failed to forward tool progress', error);
        });
        if (notification) pendingProgressNotifications.push(notification);
      }
      : undefined;
    try {
      const options = {
        ...(extra?.signal === undefined ? {} : { signal: extra.signal }),
        ...(extra?._meta === undefined ? {} : { requestMetadata: extra._meta }),
        ...(onprogress === undefined ? {} : { onprogress }),
      };
      const result = Object.keys(options).length === 0
        ? await callHttpTool(name, args)
        : await callHttpTool(name, args, options);
      await Promise.all(pendingProgressNotifications);
      return result;
    } catch (error) {
      if (extra?.signal?.aborted === true) throw error;
      return {
        content: [
          { type: 'text', text: `Failed to call tool ${name}: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
        ...(error instanceof McpError && error.code === ErrorCode.RequestTimeout
          ? { structuredContent: { code: error.code } }
          : {}),
      };
    }
  };
}
