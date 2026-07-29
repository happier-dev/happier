import { describe, expect, it } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { AGENTS_CORE } from '../../manifest.js';

import {
  evaluateVendorResumeEligibility,
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

  it('requires Claude transcript continuity proof before derived resume is eligible', () => {
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'claude',
        metadata: { claudeSessionId: 'c1' },
        accountSettings: {},
      }),
    ).toEqual({ eligible: false, reasonCode: 'vendor_resume_continuity_proof_missing' });
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'claude',
        metadata: { claudeSessionId: 'c1', claudeTranscriptPath: '   ' },
        accountSettings: {},
      }),
    ).toEqual({ eligible: false, reasonCode: 'vendor_resume_continuity_proof_missing' });
    expect(
      evaluateVendorResumeEligibility({
        agentId: 'claude',
        metadata: { claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' },
        accountSettings: {},
      }),
    ).toEqual({ eligible: true, vendorResumeId: 'c1' });
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
        accountSettings: {
          codexBackendMode: 'acp',
          backendEnabledByTargetKey: {
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: false,
          },
        },
      }),
    ).toEqual({ eligible: false, reasonCode: 'backend_disabled_by_account_settings' });
  });
});
