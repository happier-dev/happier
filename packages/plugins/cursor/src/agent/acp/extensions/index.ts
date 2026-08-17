import type {
  AgentAcpRuntimeExtensions,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { createCursorAcpExtensionHandlers } from './handlers.js';

export function createCursorAcpRuntimeExtensions(params: Readonly<{
  context: AgentSessionRuntimeContext;
  mediaSourceRoot?: string;
}>): AgentAcpRuntimeExtensions {
  const handlers = createCursorAcpExtensionHandlers(params);
  return Object.freeze({
    requests: Object.freeze({
      'cursor/ask_question': handlers.askQuestion,
      'cursor/create_plan': handlers.createPlan,
      'cursor/update_todos': handlers.updateTodosRequest,
      'cursor/task': handlers.taskRequest,
      'cursor/generate_image': handlers.generatedMediaRequest,
    }),
    notifications: Object.freeze({
      'cursor/update_todos': handlers.updateTodosNotification,
      'cursor/task': handlers.taskNotification,
      'cursor/generate_image': handlers.generatedMediaNotification,
    }),
  });
}

export {
  cursorAskQuestionRequestSchema,
  cursorAskQuestionResponseSchema,
  cursorCreatePlanRequestSchema,
  cursorCreatePlanResponseSchema,
  cursorGenerateImageNotificationSchema,
  cursorTaskNotificationSchema,
  cursorUpdateTodosRequestSchema,
} from './schemas.js';
export { parseCursorGeneratedMedia, parseCursorTaskRequest } from './taskMedia.js';
