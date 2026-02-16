import { z } from 'zod';

/**
 * UI placement IDs are used to deterministically map actions into UI surfaces
 * (header buttons, command palette, context menus, etc.) without ad-hoc wiring.
 */
export const ACTION_UI_PLACEMENTS = [
  'agent_input_chips',
  'session_header',
  'session_info',
  'session_action_menu',
  'command_palette',
  'slash_command',
  'voice_panel',
  'run_list',
  'run_card',
] as const;

export const ActionUiPlacementSchema = z.enum(ACTION_UI_PLACEMENTS);
export type ActionUiPlacement = z.infer<typeof ActionUiPlacementSchema>;
