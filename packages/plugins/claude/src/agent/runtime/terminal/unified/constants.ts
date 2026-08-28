export const CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID = 'claude';

/**
 * Claude-owned source discriminant for its unified-terminal dialog request.
 * Protocol verifies literal parity at the host boundary; the plugin does not
 * reach into the host-private Protocol package for its own authored value.
 */
export const CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE =
  'claude_unified_terminal_dialog_choice' as const;
