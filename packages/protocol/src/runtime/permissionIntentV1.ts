import type { z } from 'zod';

import {
  defineProtocolLiteral,
  defineProtocolUnion,
} from '../plugins/actions/jsonSchemaValidation.js';
import { parseSessionPermissionModeAlias } from '../sessions/metadata/sessionPermissionModes.js';

/**
 * Leaf owner for permission-intent vocabulary shared by runtime configuration
 * and Session input admission. Keeping it independent prevents the Session
 * admission authority from importing the runtime event graph.
 */
export const AGENT_PERMISSION_INTENTS_V1 = [
  'default',
  'read-only',
  'safe-yolo',
  'yolo',
  'plan',
] as const;

export const AgentPermissionIntentV1Schema = defineProtocolUnion([
  defineProtocolLiteral(AGENT_PERMISSION_INTENTS_V1[0]),
  defineProtocolLiteral(AGENT_PERMISSION_INTENTS_V1[1]),
  defineProtocolLiteral(AGENT_PERMISSION_INTENTS_V1[2]),
  defineProtocolLiteral(AGENT_PERMISSION_INTENTS_V1[3]),
  defineProtocolLiteral(AGENT_PERMISSION_INTENTS_V1[4]),
]);
export type AgentPermissionIntentV1 = ReturnType<typeof AgentPermissionIntentV1Schema.parse>;

export function parseAgentPermissionIntentV1Alias(raw: string): AgentPermissionIntentV1 | null {
  const parsed = parseSessionPermissionModeAlias(raw);
  if (!parsed) return null;
  if (parsed === 'acceptEdits') return 'safe-yolo';
  if (parsed === 'bypassPermissions') return 'yolo';
  const intent = AgentPermissionIntentV1Schema.safeParse(parsed);
  return intent.success ? intent.data : null;
}
