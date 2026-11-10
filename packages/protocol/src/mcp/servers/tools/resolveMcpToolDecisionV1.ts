import type { AgentPermissionIntentV1 } from '../../../runtime/permissionIntentV1.js';
import type { McpServerToolPolicyV1, McpServerToolsSnapshotV1, McpToolAnnotationsV1 } from '../settingsV1.js';
import { z } from '../../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolUnion } from '../../../plugins/actions/protocolComposableSchema.js';
import { asProtocolZod } from '../../../plugins/actions/internalProtocolZodAdapter.js';

export type McpToolDecisionV1 = Readonly<{ exposed: boolean; approval: 'allow' | 'ask' | 'deny'; effectClass: 'read' | 'write' | 'unknown'; source: 'tool' | 'server_default' | 'permission_mode' }>;
export const McpToolDecisionV1Schema = lazyZodSchema(() => z.strictObject({
  exposed: z.boolean(), approval: z.enum(['allow', 'ask', 'deny']), effectClass: z.enum(['read', 'write', 'unknown']), source: z.enum(['tool', 'server_default', 'permission_mode']),
}));
export type McpToolLaunchPolicyV1 = Readonly<{ unlisted: 'allow' | 'ask' | 'deny'; tools: Readonly<Record<string, 'off' | 'allow' | 'ask' | 'deny'>> }>;
const McpToolApprovalV1Definition = defineProtocolUnion([
  defineProtocolLiteral('allow'), defineProtocolLiteral('ask'), defineProtocolLiteral('deny'),
]);
const McpToolLaunchPolicyV1Definition = defineProtocolObject({
  unlisted: McpToolApprovalV1Definition,
  tools: defineProtocolObject({}, { policy: 'additive-open/preserve',
    additionalProperties: defineProtocolUnion([defineProtocolLiteral('off'), McpToolApprovalV1Definition]) }),
}, { policy: 'closed' });
export const McpToolLaunchPolicyV1Schema: z.ZodMiniType<McpToolLaunchPolicyV1, McpToolLaunchPolicyV1> = asProtocolZod(McpToolLaunchPolicyV1Definition);
export const McpToolLaunchPoliciesV1Schema: z.ZodMiniType<Readonly<Record<string, McpToolLaunchPolicyV1>>, Readonly<Record<string, McpToolLaunchPolicyV1>>> = asProtocolZod(defineProtocolObject({}, {
  policy: 'additive-open/preserve', additionalProperties: McpToolLaunchPolicyV1Definition,
}));

export function resolveMcpToolDecisionV1(input: Readonly<{ policy: McpServerToolPolicyV1 | undefined; toolName: string; annotations?: McpToolAnnotationsV1; permissionMode: AgentPermissionIntentV1 }>): McpToolDecisionV1 {
  const defaultSetting = input.policy?.default ?? 'ask';
  const override = input.policy && Object.hasOwn(input.policy.overrides, input.toolName)
    ? input.policy.overrides[input.toolName] : undefined;
  const effectClass = defaultSetting === 'allow_read_only' && input.annotations?.readOnlyHint === true ? 'read' : 'unknown';
  const source = override === undefined ? 'server_default' : 'tool';
  if (override === 'off') return { exposed: false, approval: 'deny', effectClass, source };
  const requested = override ?? (defaultSetting === 'allow_all' || defaultSetting === 'allow_read_only' && effectClass === 'read' ? 'allow' : 'ask');
  const approval = input.permissionMode === 'yolo' ? 'allow'
    : input.permissionMode === 'read-only' || input.permissionMode === 'plan' ? effectClass === 'read' ? 'allow' : 'deny'
      : requested;
  return { exposed: true, approval, effectClass, source: approval === requested ? source : 'permission_mode' };
}
export function projectMcpToolLaunchPolicyV1(input: Readonly<{ policy: McpServerToolPolicyV1 | undefined; snapshot: McpServerToolsSnapshotV1 | undefined; permissionMode: AgentPermissionIntentV1 }>): McpToolLaunchPolicyV1 {
  const snapshots = new Map(input.snapshot?.tools.map(tool => [tool.name, tool]) ?? []);
  const names = new Set([...snapshots.keys(), ...Object.keys(input.policy?.overrides ?? {})]);
  const tools = Object.fromEntries([...names].map(toolName => {
    const decision = resolveMcpToolDecisionV1({ policy: input.policy, toolName, annotations: snapshots.get(toolName)?.annotations, permissionMode: input.permissionMode });
    return [toolName, decision.exposed ? decision.approval : 'off'] as const;
  }));
  const unlisted = resolveMcpToolDecisionV1({ policy: input.policy ? { default: input.policy.default, overrides: {} } : undefined,
    toolName: '', permissionMode: input.permissionMode }).approval;
  return { unlisted, tools };
}
