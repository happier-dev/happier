import type { ActionId, ActionSurfaces } from '../actions/index.js';

export type MemoryRecallGuidanceSurface = keyof Pick<ActionSurfaces, 'mcp' | 'voice_tool' | 'voice_action_block'>;

export const MEMORY_RECALL_GUIDANCE_REQUIRED_ACTION_IDS = [
  'memory.search',
  'memory.get_window',
] as const satisfies readonly ActionId[];

const DEFAULT_MEMORY_RECALL_GUIDANCE_SURFACES = ['mcp'] as const satisfies readonly MemoryRecallGuidanceSurface[];

export function isMemoryRecallGuidanceSupported(args: Readonly<{
  surfaces?: readonly MemoryRecallGuidanceSurface[];
  isActionEnabled: (actionId: ActionId, surface: MemoryRecallGuidanceSurface) => boolean;
}>): boolean {
  const surfaces =
    args.surfaces && args.surfaces.length > 0 ? args.surfaces : DEFAULT_MEMORY_RECALL_GUIDANCE_SURFACES;

  return surfaces.some((surface) =>
    MEMORY_RECALL_GUIDANCE_REQUIRED_ACTION_IDS.every((actionId) => args.isActionEnabled(actionId, surface)));
}
