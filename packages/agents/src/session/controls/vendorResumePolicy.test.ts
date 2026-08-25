import { describe, expect, it } from 'vitest';
import { accountSettingsParse, buildBackendTargetKey } from '@happier-dev/protocol';

import { AGENTS_CORE } from '../../manifest.js';

import {
  evaluateVendorResumeEligibility,
  resolveAgentNativeResumeIdentityFromSessionMetadata,
  resolveAgentNativeTranscriptPathFromSessionMetadata,
  resolveVendorResumeIdFromSessionMetadata,
} from './vendorResumePolicy.js';

describe('vendorResumePolicy', () => {
  const antigravityLinkedSession = {
    v: 1 as const,
    agentId: 'antigravity' as const,
    machineId: 'machine-1',
    remoteSessionId: 'conversation-1',
    source: {
      kind: 'antigravityCliPrint' as const,
      brainDir: '/tmp/antigravity-brain',
    },
    qualifiedIdentity: {
      v: 1 as const,
      agent: {
        pluginId: 'happier.agent.antigravity',
        localId: 'antigravity',
      },
      source: {
        kind: 'antigravityCliPrint',
        contractVersion: 1 as const,
      },
    },
  };
  const currentAntigravityAgent = {
    identity: {
      pluginId: 'happier.agent.antigravity',
      localId: 'antigravity',
    },
    sourceKinds: ['antigravityCliPrint'],
  };

  it('exposes claudeSessionId as the Claude vendor resume id field', () => {
    expect(AGENTS_CORE.claude.resume.vendorResumeIdField).toBe('claudeSessionId');
    // The same catalog slot, now read ONLY as the Agent's own session-log
    // pointer for the handoff brief — it gates nothing (`AM-24`). The key name
    // is predecessor vocabulary held by a generated projection; see
    // `AgentResumeConfig`.
    expect(AGENTS_CORE.claude.resume.vendorResumeContinuityProofField).toBe('claudeTranscriptPath');
  });

  it('resolves vendor resume ids from metadata (trimmed)', () => {
    expect(resolveVendorResumeIdFromSessionMetadata('claude', { claudeSessionId: ' c1 ' })).toBe('c1');
    expect(resolveVendorResumeIdFromSessionMetadata('claude', { claudeSessionId: '   ' })).toBeNull();
  });

  it('resolves the generated Grok vendor resume field from session metadata', () => {
    expect(AGENTS_CORE.grok.resume.vendorResumeIdField).toBe('grokSessionId');
    expect(resolveVendorResumeIdFromSessionMetadata('grok', { grokSessionId: ' grok-session-1 ' }))
      .toBe('grok-session-1');
  });

  it('resumes Claude from its recorded id with no continuity proof of any kind', () => {
    // `AM-24`. The proof gate is gone: a recorded id is either still resumable,
    // which resuming answers, or it is not — and Claude raises
    // `ClaudeAgentSdkResumeIdentityMismatchError` when it is not, so there was
    // never a silent-zero-context path for a pre-check to prevent. It was also
    // never general: 15 Agents declare vendor resume and exactly one declared a
    // proof field, so the canonical Codex→Claude→Codex round trip had no gate.
    for (const metadata of [
      { claudeSessionId: 'c1' },
      { claudeSessionId: 'c1', claudeTranscriptPath: '   ' },
      { claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' },
    ]) {
      expect(
        evaluateVendorResumeEligibility({ agentId: 'claude', metadata, accountSettings: {} }),
      ).toEqual({ eligible: true, vendorResumeId: 'c1' });
    }
  });

  it('does not impose Claude transcript proof on other provider resume policy', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'ohMyPi',
        metadata: { ohMyPiSessionId: 'omp-session-1' },
        accountSettings: {},
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'omp-session-1' });
  });

  it('prefers vendor session ids from runtimeDescriptorV1 over legacy top-level metadata', () => {
    expect(resolveVendorResumeIdFromSessionMetadata('codex', {
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: { backendMode: 'appServer', providerSessionId: 'runtime_thread' },
      },
      codexSessionId: 'legacy_thread',
    })).toBe('runtime_thread');
  });

  it('keeps legacy agentRuntimeDescriptorV1 read-compat for vendor session ids', () => {
    expect(resolveVendorResumeIdFromSessionMetadata('codex', {
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: { backendMode: 'appServer', providerSessionId: 'runtime_thread' },
      },
      codexSessionId: 'legacy_thread',
    })).toBe('runtime_thread');
  });

  it('allows Pi resume when a session id is present', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'pi',
        metadata: { piSessionId: 'p1' },
        accountSettings: {},
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'p1' });
  });

  it('allows Antigravity exact conversation resume when its canonical session id is present', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'antigravity',
        metadata: { antigravitySessionId: 'conversation-1' },
        accountSettings: {},
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'conversation-1' });
  });

  it('keeps released direct-session metadata on its predecessor resume path', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'antigravity',
        metadata: {
          antigravitySessionId: 'conversation-1',
          directSessionV1: {
            v: 1,
            providerId: 'antigravity',
            machineId: 'machine-1',
            remoteSessionId: 'conversation-1',
            source: {
              kind: 'antigravityCliPrint',
              brainDir: '/tmp/antigravity-brain',
            },
          },
        },
        accountSettings: {},
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'conversation-1' });
  });

  it('rejects released direct-session metadata when its Agent or remote session id does not match resume state', () => {
    for (const directSessionV1 of [
      {
        v: 1 as const,
        providerId: 'antigravity',
        machineId: 'machine-1',
        remoteSessionId: 'different-conversation',
        source: {
          kind: 'antigravityCliPrint',
          brainDir: '/tmp/antigravity-brain',
        },
      },
      {
        v: 1 as const,
        providerId: 'opencode',
        machineId: 'machine-1',
        remoteSessionId: 'conversation-1',
        source: {
          kind: 'opencodeServer',
        },
      },
    ]) {
      expect(
        evaluateVendorResumeEligibility({
          agentId: 'antigravity',
          metadata: {
            antigravitySessionId: 'conversation-1',
            directSessionV1,
          },
          accountSettings: {},
        }),
      ).toEqual({ eligible: false, reasonCode: 'linked_session_identity_unverified' });
    }
  });

  it('fails malformed released direct-session metadata closed', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'antigravity',
        metadata: {
          antigravitySessionId: 'conversation-1',
          directSessionV1: {
            v: 1,
            providerId: 'antigravity',
          },
        },
        accountSettings: {},
      }),
    ).toEqual({ eligible: false, reasonCode: 'linked_session_identity_unverified' });
  });

  it('requires a linked vendor resume id to exactly match the current remote session id', () => {
    for (const antigravitySessionId of ['different-conversation', ' conversation-1 ']) {
      expect(
        evaluateVendorResumeEligibility({
          agentId: 'antigravity',
          metadata: {
            antigravitySessionId,
            externalSessionV1: antigravityLinkedSession,
          },
          accountSettings: {},
          linkedSessionCurrentAgent: currentAntigravityAgent,
        }),
      ).toEqual({ eligible: false, reasonCode: 'linked_session_identity_unverified' });
    }
  });

  it('rejects linked vendor resume when the qualified identity is missing or malformed', () => {
    for (const qualifiedIdentity of [
      undefined,
      {
        v: 1,
        agent: {
          pluginId: 'happier.agent.antigravity',
        },
        source: {
          kind: 'antigravityCliPrint',
          contractVersion: 1,
        },
      },
    ]) {
      expect(
        evaluateVendorResumeEligibility({
          agentId: 'antigravity',
          metadata: {
            antigravitySessionId: 'conversation-1',
            externalSessionV1: {
              ...antigravityLinkedSession,
              qualifiedIdentity,
            },
          },
          accountSettings: {},
          linkedSessionCurrentAgent: currentAntigravityAgent,
        }),
      ).toEqual({ eligible: false, reasonCode: 'linked_session_identity_unverified' });
    }
  });

  it('rejects linked vendor resume after the installed Agent identity or source contract is replaced', () => {
    for (const linkedSessionCurrentAgent of [
      {
        identity: {
          pluginId: 'replacement.antigravity',
          localId: 'antigravity',
        },
        sourceKinds: ['antigravityCliPrint'],
      },
      {
        identity: {
          pluginId: 'happier.agent.antigravity',
          localId: 'antigravity',
        },
        sourceKinds: ['replacementSource'],
      },
    ]) {
      expect(
        evaluateVendorResumeEligibility({
          agentId: 'antigravity',
          metadata: {
            antigravitySessionId: 'conversation-1',
            externalSessionV1: antigravityLinkedSession,
          },
          accountSettings: {},
          linkedSessionCurrentAgent,
        }),
      ).toEqual({ eligible: false, reasonCode: 'linked_session_identity_unverified' });
    }
  });

  it('allows linked vendor resume when the id, qualified Agent, and source contract are current', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'antigravity',
        metadata: {
          antigravitySessionId: 'conversation-1',
          externalSessionV1: antigravityLinkedSession,
        },
        accountSettings: {},
        linkedSessionCurrentAgent: currentAntigravityAgent,
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'conversation-1' });
  });

  it('prefers Pi absolute session-file metadata over bare session ids for resume', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'pi',
        metadata: {
          piSessionId: 'p1',
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'pi',
            provider: {
              resumeStrategy: 'sessionFileAbsolutePreferred',
              providerSessionId: 'p1',
              sessionFile: '/tmp/pi/sessions/2026-05-27T00-00-00-000Z_p1.jsonl',
            },
          },
        },
        accountSettings: {},
      }),
    ).toEqual({ eligible: true, vendorResumeId: '/tmp/pi/sessions/2026-05-27T00-00-00-000Z_p1.jsonl' });
  });

  it('rejects when vendor resume id is missing', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'claude',
        metadata: { flavor: 'claude' },
        accountSettings: {},
      }),
    ).toEqual({ eligible: false, reasonCode: 'vendor_resume_id_missing' });
  });

  it('rejects experimental codex resume when ACP is disabled by settings', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'codex',
        metadata: { codexSessionId: 'x1' },
        accountSettings: { codexBackendMode: 'mcp' },
      }),
    ).toEqual({ eligible: false, reasonCode: 'experimental_disabled' });
  });

  it('allows experimental codex resume when ACP is enabled by settings', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'codex',
        metadata: { codexSessionId: 'x1' },
        accountSettings: { codexBackendMode: 'acp' },
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'x1' });
  });

  it('allows codex resume when appServer is enabled by settings', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'codex',
        metadata: { codexSessionId: 'x1' },
        accountSettings: { codexBackendMode: 'appServer' },
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'x1' });
  });

  it('allows runtime-checked experimental Cursor resume when a session id is present', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'cursor',
        metadata: { cursorSessionId: 'cursor-session-1' },
        accountSettings: {},
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'cursor-session-1' });
  });

  it('keeps experimental Kiro resume disabled by default', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'kiro',
        metadata: { kiroSessionId: 'kiro-session-1' },
        accountSettings: {},
      }),
    ).toEqual({ eligible: false, reasonCode: 'experimental_disabled' });
  });

  it('allows ohMyPi resume when a session id is present', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'ohMyPi',
        metadata: { ohMyPiSessionId: 'omp-session-1' },
        accountSettings: {},
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'omp-session-1' });
  });

  it('prefers persisted codexBackendMode metadata over account settings for appServer sessions', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'codex',
        metadata: { codexSessionId: 'x1', codexBackendMode: 'appServer' },
        accountSettings: { codexBackendMode: 'mcp' },
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'x1' });
  });

  it('prefers persisted codexBackendMode metadata over account settings for mcp sessions', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'codex',
        metadata: { codexSessionId: 'x1', codexBackendMode: 'mcp' },
        accountSettings: { codexBackendMode: 'appServer' },
      }),
    ).toEqual({ eligible: false, reasonCode: 'experimental_disabled' });
  });

  it('prefers codexRuntimeDescriptorV1 over legacy codexBackendMode metadata', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'codex',
        metadata: {
          codexSessionId: 'x1',
          codexRuntimeDescriptorV1: { v: 1, backendMode: 'appServer' },
          codexBackendMode: 'mcp',
        },
        accountSettings: { codexBackendMode: 'mcp' },
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'x1' });
  });

  it('infers appServer resume eligibility for legacy Codex sessions from generic codex control metadata', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'codex',
        metadata: {
          codexSessionId: 'x1',
          sessionConfigOptionsV1: {
            v: 1,
            agentId: 'codex',
            updatedAt: 1,
            options: [],
          },
        },
        accountSettings: { codexBackendMode: 'mcp' },
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'x1' });
  });

  it('rejects when the backend is disabled by account settings', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'codex',
        metadata: { codexSessionId: 'x1' },
        // The fixture is the canonical PARSED projection, not a record keyed by
        // the same builder the policy used to call. Restating that builder here
        // made the assertion pass for any key vocabulary, including one the
        // catalog no longer stores.
        accountSettings: accountSettingsParse({
          codexBackendMode: 'acp',
          backendEnabledByTargetKey: {
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: false,
          },
        }) as unknown as Record<string, unknown>,
      }),
    ).toEqual({ eligible: false, reasonCode: 'backend_disabled_by_account_settings' });
  });
});

describe('resolveAgentNativeResumeIdentityFromSessionMetadata', () => {
  it('returns the id from the Agent’s catalog-declared slot and nothing else', () => {
    expect(
      resolveAgentNativeResumeIdentityFromSessionMetadata('claude', {
        claudeSessionId: 'claude-1',
        claudeTranscriptPath: '/home/u/.claude/p/claude-1.jsonl',
      }),
    ).toEqual({ v: 1, vendorResumeId: 'claude-1' });
  });

  it('returns the id whether or not the Agent’s log path is stored', () => {
    expect(
      resolveAgentNativeResumeIdentityFromSessionMetadata('claude', { claudeSessionId: 'claude-1' }),
    ).toEqual({ v: 1, vendorResumeId: 'claude-1' });
  });

  it('returns null when the Agent has no recorded id', () => {
    expect(resolveAgentNativeResumeIdentityFromSessionMetadata('claude', { codexSessionId: 'c' })).toBeNull();
  });
});

describe('resolveAgentNativeTranscriptPathFromSessionMetadata', () => {
  /**
   * The successor-facing POINTER, and the one surviving reader of the
   * catalog-declared log-path slot. Its whole job is to hand the incoming Agent
   * somewhere to read; it decides nothing about resuming (`AM-24`).
   */
  it('reads the declaring Agent’s own log path', () => {
    expect(
      resolveAgentNativeTranscriptPathFromSessionMetadata('claude', {
        claudeSessionId: 'claude-1',
        claudeTranscriptPath: ' /home/u/.claude/p/claude-1.jsonl ',
      }),
    ).toBe('/home/u/.claude/p/claude-1.jsonl');
  });

  it('never hands one Agent another Agent’s log', () => {
    // Codex declares no log-path slot; borrowing Claude's key would point the
    // reader at a conversation that is not the one being handed over.
    expect(
      resolveAgentNativeTranscriptPathFromSessionMetadata('codex', {
        codexSessionId: 'codex-1',
        claudeTranscriptPath: '/home/u/.claude/p/claude-1.jsonl',
      }),
    ).toBeNull();
  });

  it('reads a blank or non-string slot as no log', () => {
    expect(
      resolveAgentNativeTranscriptPathFromSessionMetadata('claude', { claudeTranscriptPath: '   ' }),
    ).toBeNull();
    expect(
      resolveAgentNativeTranscriptPathFromSessionMetadata('claude', { claudeTranscriptPath: 7 }),
    ).toBeNull();
  });
});

/**
 * An external (manifest-contributed) Agent has no generated `<vendor>SessionId`
 * slot and no generated session-control adapter. Its native conversation id
 * lives in the one open, agent-agnostic carrier — the runtime descriptor — and
 * the canonical resume-id owner must read it there, or the daemon derives no
 * resume id and silently respawns a FRESH provider session.
 */
describe('resolveVendorResumeIdFromSessionMetadata — external Agent runtime descriptor', () => {
  const externalDescriptorMetadata = (providerSessionId: string, agentId = 'acme') => ({
    runtimeDescriptorV1: {
      v: 1,
      agentId,
      agent: {
        backendMode: 'custom',
        providerSessionId,
      },
    },
  });

  it('reads an external Agent’s native session id from the runtime descriptor', () => {
    expect(
      resolveVendorResumeIdFromSessionMetadata('acme', externalDescriptorMetadata(' acme-native-1 ')),
    ).toBe('acme-native-1');
  });

  it('never hands one Agent another Agent’s descriptor session id', () => {
    expect(
      resolveVendorResumeIdFromSessionMetadata('acme', externalDescriptorMetadata('other-native-1', 'other')),
    ).toBeNull();
  });

  it('keeps the generated adapter authoritative for a bundled Agent', () => {
    // Pi's adapter prefers its absolute session-file path over the descriptor's
    // bare providerSessionId. A generic descriptor tier must not overtake it.
    expect(
      resolveVendorResumeIdFromSessionMetadata('pi', {
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'pi',
          agent: {
            backendMode: 'rpc',
            providerSessionId: 'pi-bare-id',
            sessionFile: '/home/u/.pi/sessions/pi-1.json',
          },
        },
      }),
    ).toBe('/home/u/.pi/sessions/pi-1.json');
  });

  it('keeps the catalog-declared flat field authoritative for a bundled Agent', () => {
    expect(
      resolveVendorResumeIdFromSessionMetadata('claude', {
        claudeSessionId: 'claude-flat-1',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'claude',
          agent: { backendMode: 'sdk', providerSessionId: 'claude-descriptor-1' },
        },
      }),
    ).toBe('claude-flat-1');
  });
});
