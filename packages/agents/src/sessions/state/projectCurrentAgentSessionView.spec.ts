import { describe, expect, it } from 'vitest';

import { AGENTS_CORE } from '../../manifest.js';
import { AGENT_IDS } from '../../types.js';
import {
  listVendorResumeIdMetadataKeys,
  projectCurrentAgentSessionView,
} from './projectCurrentAgentSessionView.js';

const UPDATED_AT = 1_800_000_000_000;

function sourceMetadata(): Record<string, unknown> {
  return {
    path: '/work/repo',
    host: 'mac',
    machineId: 'machine-1',
    homeDir: '/Users/dev',
    happyHomeDir: '/Users/dev/.happier',
    happyLibDir: '/Users/dev/.happier/lib',
    happyToolsDir: '/Users/dev/.happier/tools',
    startedBy: 'daemon',
    permissionMode: 'default',
    permissionModeUpdatedAt: 10,
    profileId: 'work',
    flavor: 'claude',
    claudeSessionId: 'claude-native-1',
    claudeTranscriptPath: '/Users/dev/.claude/projects/x.jsonl',
    claudeLastAssistantUuid: 'uuid-1',
    agentRuntimeDescriptorV1: { v: 1, providerId: 'claude' },
    tools: ['Bash'],
    slashCommands: ['/compact'],
    capabilities: { inFlightSteer: true },
    sessionWorkStateV1: { v: 1, items: [] },
    sessionModesV1: { v: 1, provider: 'claude', updatedAt: 1, currentModeId: 'plan', availableModes: [] },
    modelOverrideV1: { v: 1, updatedAt: 5, modelId: 'claude-opus' },
    sessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' },
    forkV1: { v: 1, parentSessionId: 'parent', parentCutoffSeqInclusive: 7 },
    handoffV1: { v: 1, lineage: 'x' },
    connectedServices: { v: 1, bindingsByServiceId: {} },
    summary: { text: 'a summary', updatedAt: 3 },
  };
}

describe('projectCurrentAgentSessionView', () => {
  it('leaves exactly one declared identity and no flat vendor resume key', () => {
    const next = projectCurrentAgentSessionView({
      metadata: sourceMetadata(),
      target: { agentId: 'codex', updatedAtMs: UPDATED_AT },
    });

    expect(next.flavor).toBe('codex');
    for (const key of listVendorResumeIdMetadataKeys()) {
      expect(next[key]).toBeUndefined();
    }
    expect(next.agentRuntimeDescriptorV1).toBeUndefined();
    expect(next.acpConfiguredBackendV1).toBeUndefined();
  });

  it('enumerates every agent resume key from the manifest, not a local list', () => {
    const expected = AGENT_IDS
      .map((agentId) => {
        const resume = AGENTS_CORE[agentId].resume;
        return 'vendorResumeIdField' in resume ? resume.vendorResumeIdField ?? null : null;
      })
      .filter((field): field is string => typeof field === 'string');

    expect([...listVendorResumeIdMetadataKeys()].sort()).toEqual([...new Set(expected)].sort());
  });

  it('drops every vendor resume key even when several are already present', () => {
    const next = projectCurrentAgentSessionView({
      metadata: {
        ...sourceMetadata(),
        codexSessionId: 'codex-native-1',
        geminiSessionId: 'gemini-native-1',
      },
      target: { agentId: 'codex', updatedAtMs: UPDATED_AT },
    });

    expect(next.claudeSessionId).toBeUndefined();
    expect(next.codexSessionId).toBeUndefined();
    expect(next.geminiSessionId).toBeUndefined();
  });

  it('drops the source Agent continuity proof, never carrying a native path across Agents', () => {
    const next = projectCurrentAgentSessionView({
      metadata: sourceMetadata(),
      target: { agentId: 'codex', updatedAtMs: UPDATED_AT },
    });

    expect(next.claudeTranscriptPath).toBeUndefined();
    expect(next.claudeLastAssistantUuid).toBeUndefined();
  });

  it('clears current runtime projections and keeps Session history and identity facts', () => {
    const next = projectCurrentAgentSessionView({
      metadata: sourceMetadata(),
      target: { agentId: 'codex', updatedAtMs: UPDATED_AT },
    });

    for (const cleared of ['tools', 'slashCommands', 'capabilities', 'sessionWorkStateV1', 'sessionModesV1']) {
      expect(next[cleared]).toBeUndefined();
    }
    expect(next.path).toBe('/work/repo');
    expect(next.machineId).toBe('machine-1');
    expect(next.permissionMode).toBe('default');
    expect(next.profileId).toBe('work');
    expect(next.forkV1).toEqual({ v: 1, parentSessionId: 'parent', parentCutoffSeqInclusive: 7 });
    expect(next.handoffV1).toEqual({ v: 1, lineage: 'x' });
    expect(next.connectedServices).toEqual({ v: 1, bindingsByServiceId: {} });
    expect(next.summary).toEqual({ text: 'a summary', updatedAt: 3 });
  });

  it('clears the source Agent MCP selection and usage-limit recovery record', () => {
    // Both describe the DEPARTED runtime. A usage-limit recovery record names
    // the source Agent's provider account and its retry window, and an MCP
    // selection is a per-Agent choice the target never made — carried over,
    // the Session shows the previous Agent's rate-limit banner and its server
    // selection under a runtime that has none of it. The recovery record is
    // eventually republished; the MCP selection is a user choice and may never
    // be.
    const next = projectCurrentAgentSessionView({
      metadata: {
        ...sourceMetadata(),
        mcpSelectionV1: { v: 1, updatedAt: 5, selectedServerIds: ['playwright'] },
        sessionUsageLimitRecoveryV1: { v: 1, updatedAt: 5, resetAtMs: 9_000 },
      },
      target: { agentId: 'codex', updatedAtMs: UPDATED_AT },
    });

    expect(next.mcpSelectionV1).toBeUndefined();
    expect(next.sessionUsageLimitRecoveryV1).toBeUndefined();
  });

  it('drops a source model/mode selection when the target supplies none', () => {
    const next = projectCurrentAgentSessionView({
      metadata: sourceMetadata(),
      target: { agentId: 'codex', updatedAtMs: UPDATED_AT },
    });

    expect(next.modelOverrideV1).toBeUndefined();
    expect(next.sessionModeOverrideV1).toBeUndefined();
    expect(next.acpSessionModeOverrideV1).toBeUndefined();
  });

  it('writes the target model, mode and config overrides at the transition timestamp', () => {
    const next = projectCurrentAgentSessionView({
      metadata: sourceMetadata(),
      target: {
        agentId: 'codex',
        modelId: 'gpt-5.6',
        sessionModeId: 'code',
        sessionConfigOptionOverrides: { v: 1, updatedAt: UPDATED_AT, overrides: {} },
        updatedAtMs: UPDATED_AT,
      },
    });

    expect(next.modelOverrideV1).toEqual({ v: 1, updatedAt: UPDATED_AT, modelId: 'gpt-5.6' });
    expect(next.sessionModeOverrideV1).toEqual({ v: 1, updatedAt: UPDATED_AT, modeId: 'code' });
    expect(next.acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: UPDATED_AT, modeId: 'code' });
    expect(next.sessionConfigOptionOverridesV1).toEqual({ v: 1, updatedAt: UPDATED_AT, overrides: {} });
    expect(next.acpConfigOptionOverridesV1).toEqual({ v: 1, updatedAt: UPDATED_AT, overrides: {} });
  });

  it('does not mutate the source metadata record', () => {
    const metadata = sourceMetadata();
    projectCurrentAgentSessionView({
      metadata,
      target: { agentId: 'codex', updatedAtMs: UPDATED_AT },
    });

    expect(metadata.claudeSessionId).toBe('claude-native-1');
    expect(metadata.flavor).toBe('claude');
  });
});

describe('projectCurrentAgentSessionView — handoff carry policy', () => {
  const HANDOFF_SOURCE = {
    flavor: 'opencode',
    opencodeSessionId: 'op-old',
    // Legacy residue from an earlier Agent: the exact state that made a Session
    // unresumable while handoff wrote resume keys through its own mutator.
    claudeSessionId: 'stale-claude',
    claudeTranscriptPath: '/home/u/.claude/x.jsonl',
    opencodeServerBaseUrl: 'http://old.example',
    opencodeBackendMode: 'server',
    agentRuntimeDescriptorV1: { v: 1, providerId: 'opencode', provider: { backendMode: 'server' } },
    sessionWorkStateV1: { v: 1 },
    slashCommands: ['/compact'],
    modelOverrideV1: { v: 1, updatedAt: 1, modelId: 'sonnet' },
    path: '/repo/source',
  } as const;

  it('writes only the target resume key and drops every other Agent key', () => {
    const next = projectCurrentAgentSessionView({
      metadata: { ...HANDOFF_SOURCE },
      target: { agentId: 'opencode', updatedAtMs: 42 },
      nativeResumeId: 'op-new',
      agentScopedCurrentState: 'carry',
    });

    expect(next.opencodeSessionId).toBe('op-new');
    expect(next.claudeSessionId).toBeUndefined();
    expect(next.flavor).toBe('opencode');
  });

  it('carries the Agent-scoped facts a same-Agent machine move keeps true', () => {
    const next = projectCurrentAgentSessionView({
      metadata: { ...HANDOFF_SOURCE },
      target: { agentId: 'opencode', updatedAtMs: 42 },
      nativeResumeId: 'op-new',
      agentScopedCurrentState: 'carry',
    });

    // The opencode handoff provider patch READS these to derive the target's
    // server affinity, so clearing them here would break the move.
    expect(next.opencodeServerBaseUrl).toBe('http://old.example');
    expect(next.opencodeBackendMode).toBe('server');
    expect(next.agentRuntimeDescriptorV1).toBeDefined();
    expect(next.sessionWorkStateV1).toEqual({ v: 1 });
    expect(next.slashCommands).toEqual(['/compact']);
    expect(next.modelOverrideV1).toEqual({ v: 1, updatedAt: 1, modelId: 'sonnet' });
  });

  it('still clears everything Agent-scoped under the default transition policy', () => {
    const next = projectCurrentAgentSessionView({
      metadata: { ...HANDOFF_SOURCE },
      target: { agentId: 'codex', updatedAtMs: 42 },
    });

    expect(next.opencodeSessionId).toBeUndefined();
    expect(next.claudeSessionId).toBeUndefined();
    expect(next.opencodeServerBaseUrl).toBeUndefined();
    expect(next.agentRuntimeDescriptorV1).toBeUndefined();
    expect(next.sessionWorkStateV1).toBeUndefined();
    expect(next.modelOverrideV1).toBeUndefined();
  });

  it('leaves a fresh target with no flat resume key at all', () => {
    const next = projectCurrentAgentSessionView({
      metadata: { ...HANDOFF_SOURCE },
      target: { agentId: 'codex', updatedAtMs: 42 },
    });

    for (const key of listVendorResumeIdMetadataKeys()) {
      expect(next[key]).toBeUndefined();
    }
  });

  it('ignores a blank native resume id rather than writing an empty key', () => {
    const next = projectCurrentAgentSessionView({
      metadata: { ...HANDOFF_SOURCE },
      target: { agentId: 'opencode', updatedAtMs: 42 },
      nativeResumeId: '   ',
      agentScopedCurrentState: 'carry',
    });

    expect(next.opencodeSessionId).toBeUndefined();
  });
});
