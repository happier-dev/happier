/**
 * Session Update Handlers for ACP Backend
 *
 * Stable entrypoint for ACP session update handling APIs.
 * Implementation details are split into `./updates/*` modules to keep
 * responsibilities cohesive without changing import surfaces.
 */

export {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  type SessionUpdate,
  type HandlerContext,
  type HandlerResult,
} from './updates/types';

export {
  parseArgsFromContent,
  extractErrorDetail,
  extractTextFromContentBlock,
} from './updates/content';

export {
  handleAgentMessageChunk,
  handleAgentThoughtChunk,
  handleUserMessageChunk,
  handleLegacyMessageChunk,
} from './updates/messages';

export {
  markToolCallRunningAfterPermission,
  markToolCallWaitingForPermission,
  handleToolCallUpdate,
  handleToolCall,
} from './toolCalls/legacy/handlers';

export {
  handleAvailableCommandsUpdate,
  handleCurrentModeUpdate,
  handlePlanUpdate,
  handleThinkingUpdate,
} from './updates/events';
