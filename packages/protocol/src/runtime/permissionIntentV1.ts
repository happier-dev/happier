import { z } from '../zodRuntimePolicy.js';

import {
  defineProtocolLiteral,
  defineProtocolUnion,
} from '../plugins/actions/protocolComposableSchema.js';
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

/** Session-owned tool policy fields; leaf placement avoids the runtime event graph. */
export const AgentSessionToolPolicyShapeV1 = {
  allowedTools: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  unlistedTools: z.optional(z.enum(['ask', 'deny'])),
} as const;

const SHELL_TOOL_NAMES = new Set(['bash', 'execute', 'shell']);

export function isSessionPermissionShellToolName(name: string): boolean {
  return SHELL_TOOL_NAMES.has(name.toLowerCase());
}

/** Shared identity grammar; argument authorization remains with the host. */
export function parseSessionPermissionToolIdentifier(identifier: string): Readonly<{ name: string; spec?: string }> {
  const match = identifier.match(/^([^(]+)\((.*)\)$/);
  return match ? { name: match[1], spec: match[2] } : { name: identifier };
}

export type SessionPermissionToolIdentifierMatch =
  | Readonly<{ kind: 'tool' }>
  | Readonly<{ kind: 'readPath'; spec: string }>
  | Readonly<{ kind: 'shellCommand'; spec: string }>;

/** One identity decision for native availability and host permission handling. */
export function matchSessionPermissionToolIdentifier(
  identifier: string,
  toolName: string,
): SessionPermissionToolIdentifierMatch | null {
  const parsed = parseSessionPermissionToolIdentifier(identifier);
  const name = toolName.toLowerCase();
  if (isSessionPermissionShellToolName(toolName)) {
    if (!isSessionPermissionShellToolName(parsed.name)) return null;
    return parsed.spec === undefined ? { kind: 'tool' } : { kind: 'shellCommand', spec: parsed.spec };
  }
  if (identifier.toLowerCase() === name
    || (name.startsWith('mcp__') && identifier.toLowerCase().startsWith('mcp__')
      && identifier.endsWith('*') && name.startsWith(identifier.slice(0, -1).toLowerCase()))) return { kind: 'tool' };
  return name === 'read' && parsed.name.toLowerCase() === name && parsed.spec !== undefined
    ? { kind: 'readPath', spec: parsed.spec } : null;
}

export function parseAgentPermissionIntentV1Alias(raw: string): AgentPermissionIntentV1 | null {
  const parsed = parseSessionPermissionModeAlias(raw);
  if (!parsed) return null;
  if (parsed === 'acceptEdits') return 'safe-yolo';
  if (parsed === 'bypassPermissions') return 'yolo';
  const intent = AgentPermissionIntentV1Schema.safeParse(parsed);
  return intent.success ? intent.data : null;
}
