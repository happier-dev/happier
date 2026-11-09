import type { AgentAcpRuntimeDefinition, AgentAcpToolNameResolver } from '@happier-dev/plugin-sdk/agents/runtime';
import { parseMcpToolWireNameV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { DefaultTransport, type TransportHandler } from '@/agent/transport';
import { normalizePermissionOptionKind, pickPermissionOptionId } from '@/agent/acp/permissions/permissionMapping';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { ToolNameContext, ToolPattern } from '@/agent/transport/TransportHandler';
import { extractHappierToolsShellBridgeToolNameHint } from '@/agent/transport/utils/happierToolsShellBridgeToolNameHint';
import {
  findEmptyInputDefaultToolName,
  findToolNameFromId,
  findToolNameFromInputFields,
  isEmptyToolInput,
  type ToolPatternWithInputFields,
} from '@/agent/transport/utils/toolPatternInference';

import type { AcpRuntimeDefinition } from './_types';

export type AcpTransportBehaviorDefinition = Pick<
  AcpRuntimeDefinition,
  | 'backendId'
  | 'timeouts'
  | 'transportLifecycle'
  | 'toolNameInference'
  | 'stderrRules'
  | 'permissionOptionSelection'
> & Readonly<{
  permissions?: AgentAcpRuntimeDefinition['permissions'];
  callbacks?: Pick<AcpRuntimeDefinition['callbacks'], 'toolNameResolver'>;
  sanitizeToolUpdateContent?: NonNullable<TransportHandler['sanitizeToolUpdateContent']>;
  /** Exact resolved open-request keys, supplied by the host composition. */
  mcpServerKeys?: ReadonlySet<string>;
  /** Servers with a host-projected tool policy; the host retains their session grants. */
  mcpToolPolicyServerKeys?: ReadonlySet<string>;
}>;

function readPositiveMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function readPositiveMsOrNull(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return readPositiveMs(value);
}

function normalizeToolPatterns(definition: AcpTransportBehaviorDefinition): readonly ToolPatternWithInputFields[] {
  return Object.freeze((definition.toolNameInference?.patterns ?? [])
    .filter((pattern) => pattern.name.trim().length > 0 && pattern.patterns.length > 0)
    .map((pattern) => Object.freeze({
      name: pattern.name,
      patterns: Object.freeze([...pattern.patterns]),
      ...(pattern.inputFields ? { inputFields: Object.freeze([...pattern.inputFields]) } : {}),
      ...(pattern.emptyInputDefault === true ? { emptyInputDefault: true } : {}),
    })));
}

function toPublicToolPatterns(patterns: readonly ToolPatternWithInputFields[]): ToolPattern[] {
  return patterns.map((pattern) => ({
    name: pattern.name,
    patterns: [...pattern.patterns],
  }));
}

function normalizeUnknownToolNames(definition: AcpTransportBehaviorDefinition): ReadonlySet<string> {
  const names = [
    'unknown',
    'other',
    'unknown tool',
    ...(definition.toolNameInference?.unknownToolNames ?? []),
  ];
  return new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean));
}

function normalizeStringList(values: readonly string[] | undefined): readonly string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function normalizedLowerSet(values: readonly string[] | undefined): ReadonlySet<string> {
  return new Set(normalizeStringList(values).map((value) => value.toLowerCase()));
}

export function normalizeResolvedToolName(
  value: ReturnType<AgentAcpToolNameResolver>,
  semanticToolName: string,
  nativeToolName?: string,
): NonNullable<ReturnType<AgentAcpToolNameResolver>> | null {
  if (typeof value === 'object' && value !== null) return value;
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || (name === nativeToolName && name !== semanticToolName)) return null;
  return name;
}

function matchesTextRule(text: string, rule: Readonly<{
  includes: readonly string[];
  caseSensitive?: boolean;
}>): boolean {
  const needles = normalizeStringList(rule.includes);
  if (needles.length === 0) {
    return false;
  }
  const haystack = rule.caseSensitive === true ? text : text.toLowerCase();
  return needles.every((needle) => haystack.includes(rule.caseSensitive === true ? needle : needle.toLowerCase()));
}

function resolveStderrRuleMessage(
  definition: AcpTransportBehaviorDefinition,
  text: string,
): Readonly<{ message: AgentMessage | null; suppress?: boolean }> | null {
  for (const rule of definition.stderrRules?.suppress ?? []) {
    if (matchesTextRule(text, rule)) {
      return { message: null, suppress: true };
    }
  }
  for (const rule of definition.stderrRules?.statusErrors ?? []) {
    if (matchesTextRule(text, rule)) {
      return {
        message: {
          type: 'status',
          status: 'error',
          detail: rule.detail,
        },
        suppress: false,
      };
    }
  }
  return null;
}

function resolvePermissionOptionOverride(
  definition: AcpTransportBehaviorDefinition,
  options: Parameters<NonNullable<TransportHandler['pickPermissionOptionId']>>[0],
  decision: string,
): string | null | undefined {
  const approvedPreference = definition.permissionOptionSelection?.approved;
  if (approvedPreference !== 'allow_always') {
    return undefined;
  }
  const normalizedDecision = decision.trim().toLowerCase();
  if (normalizedDecision !== 'approved' && normalizedDecision !== 'approved_execpolicy_amendment') {
    return undefined;
  }
  return pickPermissionOptionId(options, 'approved_for_session');
}

function resolveCallbackToolName(params: Readonly<{
  definition: AcpTransportBehaviorDefinition;
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  context: ToolNameContext;
}>): ReturnType<typeof normalizeResolvedToolName> {
  const callback = params.definition.callbacks?.toolNameResolver;
  if (!callback) {
    return null;
  }
  return normalizeResolvedToolName(callback({
    toolName: params.context.nativeToolName ?? params.toolName,
    toolCallId: params.toolCallId,
    input: params.input,
    context: params.context,
  }), params.toolName, params.context.nativeToolName);
}

function resolveHintInputToolName(params: Readonly<{
  definition: AcpTransportBehaviorDefinition;
  input: Record<string, unknown>;
  patterns: readonly ToolPatternWithInputFields[];
  preferLongestMatch: boolean;
}>): string | null {
  const acpMetadata = params.input._acp !== null
    && typeof params.input._acp === 'object'
    && !Array.isArray(params.input._acp)
    ? params.input._acp as Readonly<Record<string, unknown>>
    : null;
  for (const field of normalizeStringList(params.definition.toolNameInference?.hintInputFields)) {
    const raw = params.input[field]
      ?? (field === 'title' ? acpMetadata?.title : undefined);
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      continue;
    }
    const toolName = findToolNameFromId(raw.trim(), params.patterns, {
      preferLongestMatch: params.preferLongestMatch,
    });
    if (toolName) {
      return toolName;
    }
  }
  return null;
}

function isInferredInvestigationTool(
  definition: AcpTransportBehaviorDefinition,
  toolCallId: string,
  toolKind?: string,
): boolean {
  const lowerToolCallId = toolCallId.toLowerCase();
  for (const pattern of normalizeStringList(definition.toolNameInference?.investigationToolIdPatterns)) {
    if (lowerToolCallId.includes(pattern.toLowerCase())) {
      return true;
    }
  }
  if (typeof toolKind === 'string' && toolKind.trim().length > 0) {
    const kinds = normalizedLowerSet(definition.toolNameInference?.investigationToolKinds);
    return kinds.has(toolKind.trim().toLowerCase());
  }
  return false;
}

export function createAcpTransportHandlerFromDefinition(
  definition: AcpTransportBehaviorDefinition,
): TransportHandler {
  const authenticationErrorDetail = definition.stderrRules?.authenticationErrorDetail?.trim();
  const base = new DefaultTransport(
    definition.backendId,
    authenticationErrorDetail ? { authenticationErrorDetail } : undefined,
  );
  const baseHandler: TransportHandler = base;
  const timeouts = definition.timeouts;
  const initMs = readPositiveMs(timeouts?.initMs);
  const initDelayMs = readPositiveMs(definition.transportLifecycle?.initDelayMs) ?? readPositiveMs(timeouts?.initDelayMs);
  const idleMs = readPositiveMs(timeouts?.idleMs);
  const promptLivenessMs = readPositiveMsOrNull(timeouts?.promptLivenessMs);
  const postPromptNoUpdatesMs = readPositiveMsOrNull(timeouts?.postPromptNoUpdatesMs);
  const postToolCallIdleMs = readPositiveMs(timeouts?.postToolCallIdleMs);
  const idleWithoutAssistantMessageMs = readPositiveMs(timeouts?.idleWithoutAssistantMessageMs);
  const preToolCallIdleMs = readPositiveMs(timeouts?.preToolCallIdleMs);

  const handler: TransportHandler = {
    agentName: base.agentName,
    getPermissionRequestScope: () => definition.permissions?.scope ?? 'turn',
    getInitTimeout: () => initMs ?? base.getInitTimeout(),
    ...(initDelayMs !== undefined ? { getInitDelayMs: () => initDelayMs } : {}),
    filterStdoutLine: (line) => {
      const filtered = base.filterStdoutLine?.(line);
      return filtered === undefined ? line : filtered;
    },
    handleStderr: (text, context) => (
      resolveStderrRuleMessage(definition, text)
      ?? base.handleStderr?.(text, context)
      ?? { message: null }
    ),
    getToolPatterns: () => {
      const patterns = normalizeToolPatterns(definition);
      return patterns.length > 0 ? toPublicToolPatterns(patterns) : base.getToolPatterns();
    },
    isInvestigationTool: (toolCallId, toolKind) => (
      isInferredInvestigationTool(definition, toolCallId, toolKind)
      || base.isInvestigationTool?.(toolCallId, toolKind)
      || false
    ),
    extractToolNameFromId: (toolCallId) => {
      const patterns = normalizeToolPatterns(definition);
      if (patterns.length > 0) {
        return findToolNameFromId(toolCallId, patterns, {
          preferLongestMatch: definition.toolNameInference?.preferLongestPattern === true,
        });
      }
      return base.extractToolNameFromId?.(toolCallId) ?? null;
    },
    determineToolName: (toolName, toolCallId, input, context) => {
      const callbackToolName = resolveCallbackToolName({ definition, toolName, toolCallId, input, context });
      if (callbackToolName && callbackToolName !== toolName) return callbackToolName;
      if (definition.mcpServerKeys) {
        if (parseMcpToolWireNameV1(toolName, definition.mcpServerKeys)) return toolName;
        const metadata = input._acp;
        const title = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata) && 'title' in metadata
          ? metadata.title : undefined;
        if (typeof title === 'string' && parseMcpToolWireNameV1(title, definition.mcpServerKeys)) return title;
      }
      const patterns = normalizeToolPatterns(definition);
      if (patterns.length === 0 && !definition.callbacks?.toolNameResolver) {
        return base.determineToolName?.(toolName, toolCallId, input, context) ?? toolName;
      }
      const preferLongestMatch = definition.toolNameInference?.preferLongestPattern === true;
      if (definition.toolNameInference?.shellBridgeHint === true) {
        const shellBridgeToolName = extractHappierToolsShellBridgeToolNameHint(input);
        if (shellBridgeToolName) return shellBridgeToolName;
      }

      if (callbackToolName) return callbackToolName;

      const directToolName = findToolNameFromId(toolName, patterns, { preferLongestMatch });
      if (directToolName) return directToolName;

      const unknownToolNames = normalizeUnknownToolNames(definition);
      const normalizedName = toolName.trim().toLowerCase();
      if (!unknownToolNames.has(normalizedName)) {
        return toolName;
      }

      const idToolName = findToolNameFromId(toolCallId, patterns, { preferLongestMatch });
      if (idToolName) return idToolName;

      const hintInputToolName = resolveHintInputToolName({
        definition,
        input,
        patterns,
        preferLongestMatch,
      });
      if (hintInputToolName) return hintInputToolName;
      const inputToolName = findToolNameFromInputFields(input, patterns);
      if (inputToolName) return inputToolName;
      if (isEmptyToolInput(input)) {
        return findEmptyInputDefaultToolName(patterns) ?? toolName;
      }
      return toolName;
    },
    ...(idleMs !== undefined ? { getIdleTimeout: () => idleMs } : {}),
    ...(preToolCallIdleMs !== undefined ? { getPreToolCallIdleTimeoutMs: () => preToolCallIdleMs } : {
      getPreToolCallIdleTimeoutMs: () => base.getPreToolCallIdleTimeoutMs(),
    }),
    ...(postPromptNoUpdatesMs !== undefined ? { getPostPromptNoUpdatesTimeoutMs: () => postPromptNoUpdatesMs } : {}),
    ...(promptLivenessMs !== undefined ? { getPromptLivenessTimeoutMs: () => promptLivenessMs } : {}),
    ...(postToolCallIdleMs !== undefined ? { getPostToolCallIdleTimeoutMs: () => postToolCallIdleMs } : {}),
    ...(idleWithoutAssistantMessageMs !== undefined ? { getIdleWithoutAssistantMessageTimeoutMs: () => idleWithoutAssistantMessageMs } : {}),
    pickPermissionOptionId: (options, decision, context) => {
      if (definition.mcpToolPolicyServerKeys && context
        && parseMcpToolWireNameV1(context.toolName, definition.mcpToolPolicyServerKeys)
        && ['approved', 'approved_for_session', 'approved_execpolicy_amendment'].includes(decision)) {
        // A native persistent grant skips the host on later calls and cannot be revoked by
        // a catalog Off edit. The canonical host already retains the session grant.
        const once = options.filter(option => normalizePermissionOptionKind(option.kind) === 'allow_once');
        return pickPermissionOptionId(once, 'approved');
      }
      return resolvePermissionOptionOverride(definition, options, decision)
        ?? baseHandler.pickPermissionOptionId?.(options, decision, context);
    },
    ...(definition.sanitizeToolUpdateContent
      ? { sanitizeToolUpdateContent: definition.sanitizeToolUpdateContent }
      : {}),
  };
  return Object.freeze(handler);
}
