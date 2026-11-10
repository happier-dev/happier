import { isSessionHappierToolsEnabled } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { resolveCodingPromptSessionTitleUpdatesModeV1 } from '@happier-dev/protocol/prompts/codingPromptBehaviorV1';
import type { AgentToolsDelivery, PromptBlockV1 } from '@happier-dev/protocol';

import { buildHappierToolsPromptAppendix } from '@/agent/tools/happierTools/runtime/buildHappierToolsPromptAppendix';
import { HAPPIER_VISUAL_ACTION_GUIDANCE, HAPPIER_VISUAL_AUTHORING_GUIDANCE } from '@/agent/tools/happierTools/runtime/visualActionPromptGuidance';

export function resolveCodingToolDeliveryBlocks(args: Readonly<{
  delivery: AgentToolsDelivery;
  sessionId: string;
  directory: string;
  memoryRecallGuidance?: Readonly<{
    enabled?: boolean;
    machineId?: string | null;
  }>;
  settings?: Record<string, unknown> | null | undefined;
  sessionTitleToolAvailable?: boolean;
  sessionMetadata?: unknown;
  sessionTitled?: boolean;
  createdAsBot?: boolean;
}>): PromptBlockV1[] {
  if (args.delivery === 'unsupported' || !isSessionHappierToolsEnabled(args.sessionMetadata)) return [];

  const scmGuidance: PromptBlockV1 = {
    id: 'tool_delivery.scm',
    scope: 'tool_delivery',
    text: 'For repository pushes and pull requests, use the Happier Actions `scm.remote.push` and `scm.pullRequest.openOrReuse` through `action_execute`. Happier keeps Git and hosting credentials in the host; do not copy them into the Agent home or request them for shell Git/gh commands.\nYou can post [Add machine](happier://settings/machines/add?path=anotherComputer) for the person to tap, or call `workspace.tabs.open` to open a screen directly.',
  };
  if (args.delivery !== 'shell_bridge') return [scmGuidance, {
    id: 'tool_delivery.visual_actions',
    scope: 'tool_delivery',
    text: `${HAPPIER_VISUAL_AUTHORING_GUIDANCE}\n\n${HAPPIER_VISUAL_ACTION_GUIDANCE}`,
  }];
  if (!args.sessionId || !args.directory) return [scmGuidance];

  return [
    scmGuidance,
    {
      id: 'tool_delivery.shell_bridge.happier_tools',
      scope: 'tool_delivery',
      text: buildHappierToolsPromptAppendix({
        sessionId: args.sessionId,
        directory: args.directory,
        sessionTitleUpdatesMode: resolveCodingPromptSessionTitleUpdatesModeV1(args.settings),
        sessionTitleToolAvailable: args.sessionTitleToolAvailable,
        createdAsBot: args.createdAsBot,
        sessionMetadata: args.sessionMetadata,
        ...(args.sessionTitled === undefined ? {} : { sessionTitled: args.sessionTitled }),
        memoryRecallGuidance: args.memoryRecallGuidance,
      }),
    },
  ];
}
