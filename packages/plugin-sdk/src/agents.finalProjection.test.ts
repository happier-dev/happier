import * as agents from '@happier-dev/agents';
import {
  buildShellCommand as canonicalBuildShellCommand,
} from '@happier-dev/agents/process/shellCommand';
import { createAgentSessionPreAdmissionBuffer as canonicalCreateAgentSessionPreAdmissionBuffer } from '@happier-dev/agents/runtime/session/preAdmissionBuffer';
import * as protocol from '@happier-dev/protocol';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import * as agentDeclarations from './agents.js';
import * as agentRuntime from './agentRuntime/index.js';
import * as agentRuntimeAuthoring from './agents/runtime/index.js';
import { assertExperimentalAgentSessionRealtimeRuntime } from './experimental/agentRuntime/realtime.js';
import { buildUsageObservationEffect as canonicalBuildUsageObservationEffect } from './usage.js';

describe('final Agent SDK projections', () => {
  it('keeps host-generated Agent inventories out of the author declaration surface', () => {
    for (const name of [
      'AGENT_MODEL_CONFIG',
      'AGENTS_CORE',
      'CANONICAL_AGENT_AUTH_PROBE_CONFIG',
      'CANONICAL_AGENT_CLI_RUNTIME_SPECS',
      'CANONICAL_AGENT_LOCAL_CLI_CONFIG',
      'CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS',
      'CANONICAL_AGENT_SESSION_MODES',
      'CANONICAL_AGENTS_CORE',
    ] as const) {
      expect(agentDeclarations, name).not.toHaveProperty(name);
    }
  });

  it('keeps declaration values as exact canonical Protocol identities', () => {
    expect(agentDeclarations.AgentSurfaceOperationCatalogV1)
      .toBe(protocol.BackendSurfaceOperationCatalogV1);
    expect(agentDeclarations.PluginAgentCapabilitiesV1Schema)
      .toBe(protocol.PluginBackendCapabilitiesV1Schema);
    expect(agentDeclarations.buildAgentTargetKeyV2)
      .toBe(protocol.buildBackendTargetKeyV2);
  });

  it('keeps Claude-only policy out of the generic Agent author seam', async () => {
    const publicSpec = await readFile(new URL('./agents/index.public.ts', import.meta.url), 'utf8');
    for (const name of [
      'CLAUDE_EFFORT_LEVELS',
      'CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE',
      'ClaudeEffortLevel',
      'buildClaudeModelOptions',
      'formatClaudeEffortLevelLabel',
      'normalizeClaudeEffortLevel',
    ] as const) {
      expect(agentDeclarations, name).not.toHaveProperty(name);
      expect(publicSpec).not.toContain(name);
    }
  });

  it('keeps Agent helper values as exact canonical Agents identities', () => {
    expect(agentRuntime.ACP_AGENT_CLI_TRANSPORT_TIMEOUTS)
      .toBe(agents.ACP_AGENT_CLI_TRANSPORT_TIMEOUTS);
    expect(agentRuntime.ACP_HAPPIER_MCP_BRIDGE_STATIC_APPROVAL_TOOL_NAMES)
      .toBe(agents.ACP_HAPPIER_MCP_BRIDGE_STATIC_APPROVAL_TOOL_NAMES);
    expect(agentRuntime.ACP_WRITE_LIKE_PERMISSION_KINDS)
      .toBe(agents.ACP_WRITE_LIKE_PERMISSION_KINDS);
    expect(agentRuntime.createAcpToolNameInferencePreset)
      .toBe(agents.createAcpToolNameInferencePreset);
    expect(agentRuntime.normalizeAcpPermissionIntent)
      .toBe(agents.normalizeAcpPermissionIntent);
    expect(agentRuntime.parsePermissionIntentAlias)
      .toBe(agents.parsePermissionIntentAlias);
    expect(agentRuntime.resolveAcpToolPermissionPolicy)
      .toBe(agents.resolveAcpToolPermissionPolicy);
    expect(agentRuntime.resolveRecoverableTurnFailureRetryDecision)
      .toBe(agents.resolveRecoverableTurnFailureRetryDecision);
    expect(agentRuntime.resolveRecoverableTurnFailureSecondFailure)
      .toBe(agents.resolveRecoverableTurnFailureSecondFailure);
    expect(agentRuntime.resolveTerminalPromptWriteTimeoutMs)
      .toBe(agents.resolveTerminalPromptWriteTimeoutMs);
    expect(agentRuntime.isRuntimeConfigUpdateOutcomeApplied)
      .toBe(agents.isRuntimeConfigUpdateOutcomeApplied);
    expect(agentRuntime.buildShellCommand).toBe(canonicalBuildShellCommand);
    expect(agentRuntime.createAgentSessionPreAdmissionBuffer)
      .toBe(canonicalCreateAgentSessionPreAdmissionBuffer);
  });

  it('keeps broad transcript metadata carriers host-internal', () => {
    for (const name of [
      'RuntimeOutboundTranscriptDispatchInputV1',
      'RuntimeOutboundTranscriptPostSendEffectV1',
      'resolveMetadataStringOverrideV1',
    ] as const) {
      expect(agentRuntime, name).not.toHaveProperty(name);
    }
  });

  it('keeps runtime schemas as exact canonical Protocol identities', () => {
    for (const name of [
      'AgentProviderBindingMaterializationV1Schema',
      'AgentRuntimeJsonValueSchema',
      'AgentSessionProviderBindingV1Schema',
      'AgentSessionRealtimeStartRequestV1Schema',
      'AgentSessionRealtimeStartResultV1Schema',
      'AgentSessionRuntimeEventSchema',
      'SessionContextUsageSnapshotV1Schema',
      'UsageObservationContextSchema',
      'UsageObservationCostSchema',
      'UsageObservationScopeSchema',
      'UsageObservationTokensSchema',
    ] as const) {
      expect(agentRuntime[name], name).toBe(protocol[name]);
    }
  });

  it('renames final local values without wrapping their identities', () => {
    expect(agentRuntime.assertAgentSessionRealtimeRuntime)
      .toBe(assertExperimentalAgentSessionRealtimeRuntime);
    expect(agentRuntime.buildUsageObservationEffect)
      .toBe(canonicalBuildUsageObservationEffect);
  });
});
