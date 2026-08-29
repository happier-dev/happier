import { DefaultTransport, type TransportHandler } from '@/agent/transport';
import { pickPermissionOptionId } from '@/agent/acp/permissions/permissionMapping';
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
  callbacks?: Pick<AcpRuntimeDefinition['callbacks'], 'toolNameResolver'>;
  sanitizeToolUpdateContent?: NonNullable<TransportHandler['sanitizeToolUpdateContent']>;
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

function normalizeResolvedToolName(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
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
}>): string | null {
  const callback = params.definition.callbacks?.toolNameResolver;
  if (!callback) {
    return null;
  }
  return normalizeResolvedToolName(callback({
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    input: params.input,
    context: params.context,
  }));
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

function resolveToolKindTimeoutMs(
  definition: AcpTransportBehaviorDefinition,
  toolKind?: string,
): number | null | undefined {
  if (typeof toolKind !== 'string' || toolKind.trim().length === 0) {
    return undefined;
  }
  const timeouts = definition.timeouts?.toolKindTimeouts;
  if (!timeouts) {
    return undefined;
  }
  const normalizedToolKind = toolKind.trim().toLowerCase();
  for (const [kind, timeout] of Object.entries(timeouts)) {
    if (kind.trim().toLowerCase() !== normalizedToolKind) {
      continue;
    }
    return readPositiveMsOrNull(timeout);
  }
  return undefined;
}

export function createAcpTransportHandlerFromDefinition(
  definition: AcpTransportBehaviorDefinition,
): TransportHandler {
  const base = new DefaultTransport(definition.backendId);
  const baseHandler: TransportHandler = base;
  const timeouts = definition.timeouts;
  const initMs = readPositiveMs(timeouts?.initMs);
  const initDelayMs = readPositiveMs(definition.transportLifecycle?.initDelayMs) ?? readPositiveMs(timeouts?.initDelayMs);
  const idleMs = readPositiveMs(timeouts?.idleMs);
  const toolCallMs = readPositiveMsOrNull(timeouts?.toolCallMs);
  const promptLivenessMs = readPositiveMsOrNull(timeouts?.promptLivenessMs);
  const postPromptNoUpdatesMs = readPositiveMsOrNull(timeouts?.postPromptNoUpdatesMs);
  const postToolCallIdleMs = readPositiveMs(timeouts?.postToolCallIdleMs);
  const idleWithoutAssistantMessageMs = readPositiveMs(timeouts?.idleWithoutAssistantMessageMs);
  const preToolCallIdleMs = readPositiveMs(timeouts?.preToolCallIdleMs);

  const handler: TransportHandler = {
    agentName: base.agentName,
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
    getToolCallTimeout: (toolCallId: string, toolKind?: string) => {
      if (isInferredInvestigationTool(definition, toolCallId, toolKind)) {
        return readPositiveMsOrNull(timeouts?.investigationToolCallMs)
          ?? base.getToolCallTimeout(toolCallId, toolKind);
      }
      const kindTimeout = resolveToolKindTimeoutMs(definition, toolKind);
      if (kindTimeout !== undefined) {
        return kindTimeout;
      }
      if (toolCallMs !== undefined) {
        return toolCallMs;
      }
      return base.getToolCallTimeout(toolCallId, toolKind);
    },
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
      const patterns = normalizeToolPatterns(definition);
      if (patterns.length === 0 && !definition.callbacks?.toolNameResolver) {
        return base.determineToolName?.(toolName, toolCallId, input, context) ?? toolName;
      }
      const preferLongestMatch = definition.toolNameInference?.preferLongestPattern === true;
      if (definition.toolNameInference?.shellBridgeHint === true) {
        const shellBridgeToolName = extractHappierToolsShellBridgeToolNameHint(input);
        if (shellBridgeToolName) return shellBridgeToolName;
      }

      const callbackToolName = resolveCallbackToolName({
        definition,
        toolName,
        toolCallId,
        input,
        context,
      });
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
    pickPermissionOptionId: (options, decision, context) => (
      resolvePermissionOptionOverride(definition, options, decision)
      ?? baseHandler.pickPermissionOptionId?.(options, decision, context)
    ),
    ...(definition.sanitizeToolUpdateContent
      ? { sanitizeToolUpdateContent: definition.sanitizeToolUpdateContent }
      : {}),
  };
  return Object.freeze(handler);
}
