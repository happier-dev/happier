import type { PromptBlockV1 } from '@happier-dev/protocol';

import { buildHappierToolsPromptAppendix } from '@/agent/tools/happierTools/runtime/buildHappierToolsPromptAppendix';

export function resolveCodingToolDeliveryBlocks(args: Readonly<{
  delivery: 'native_mcp' | 'shell_bridge' | 'unsupported';
  sessionId: string;
  directory: string;
  memoryRecallGuidance?: Readonly<{
    enabled?: boolean;
    machineId?: string | null;
  }>;
}>): PromptBlockV1[] {
  if (args.delivery !== 'shell_bridge') return [];

  return [
    {
      id: 'tool_delivery.shell_bridge.happier_tools',
      scope: 'tool_delivery',
      text: buildHappierToolsPromptAppendix({
        sessionId: args.sessionId,
        directory: args.directory,
        memoryRecallGuidance: args.memoryRecallGuidance,
      }),
    },
  ];
}
