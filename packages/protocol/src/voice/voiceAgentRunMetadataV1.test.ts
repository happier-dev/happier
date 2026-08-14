import { describe, expect, it } from 'vitest';

import { VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION } from './voiceAgentRunMetadataContract.js';
import {
  buildVoiceAgentRunMetadataV1,
  doesVoiceAgentRunMetadataMatchBackendTarget,
  isVoiceAgentRunMetadataV1,
  parseVoiceAgentRunMetadataV1,
  resolveVoiceAgentRunBackendId,
} from './voiceAgentRunMetadataV1.js';

const builtInTarget = { kind: 'builtInAgent', agentId: 'claude' } as const;
const acpTarget = { kind: 'configuredAcpBackend', backendId: 'gemini-acp' } as const;

describe('parseVoiceAgentRunMetadataV1', () => {
  it('parses a canonical record', () => {
    const parsed = parseVoiceAgentRunMetadataV1({
      v: 1,
      runId: 'run-1',
      backendId: 'claude',
      backendTarget: builtInTarget,
      resumeHandle: null,
      updatedAtMs: 1000,
      transcriptContractVersion: VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.runId).toBe('run-1');
    expect(parsed?.backendId).toBe('claude');
    expect(parsed?.transcriptContractVersion).toBe(VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION);
  });

  it('rejects records missing a load-bearing backendId', () => {
    expect(
      parseVoiceAgentRunMetadataV1({
        v: 1,
        runId: 'run-1',
        backendId: '   ',
        resumeHandle: null,
        updatedAtMs: 1000,
      }),
    ).toBeNull();
  });

  it('rejects records with the wrong version literal', () => {
    expect(
      parseVoiceAgentRunMetadataV1({
        v: 2,
        runId: 'run-1',
        backendId: 'claude',
        resumeHandle: null,
        updatedAtMs: 1000,
      }),
    ).toBeNull();
  });

  it('accepts legacy streamId input but never re-emits it', () => {
    const parsed = parseVoiceAgentRunMetadataV1({
      v: 1,
      runId: 'run-1',
      backendId: 'claude',
      resumeHandle: null,
      updatedAtMs: 1000,
      streamId: 'stream-9',
    });
    expect(parsed).not.toBeNull();
    expect(parsed && 'streamId' in parsed).toBe(false);
  });

  it('defaults the transcript contract version when missing', () => {
    const parsed = parseVoiceAgentRunMetadataV1({
      v: 1,
      runId: 'run-1',
      backendId: 'claude',
      resumeHandle: null,
      updatedAtMs: 1000,
    });
    expect(parsed?.transcriptContractVersion).toBe(VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION);
  });

  it('drops an invalid best-effort resume handle instead of exposing it as canonical', () => {
    const parsed = parseVoiceAgentRunMetadataV1({
      v: 1,
      runId: 'run-1',
      backendId: 'claude',
      resumeHandle: { kind: 'malformed-best-effort-hint' },
      updatedAtMs: 1000,
    });

    expect(parsed?.resumeHandle).toBeNull();
  });

  it('preserves a non-negative welcomedEpoch and drops invalid ones', () => {
    expect(
      parseVoiceAgentRunMetadataV1({
        v: 1,
        runId: 'run-1',
        backendId: 'claude',
        resumeHandle: null,
        updatedAtMs: 1000,
        welcomedEpoch: 4,
      })?.welcomedEpoch,
    ).toBe(4);
    expect(
      parseVoiceAgentRunMetadataV1({
        v: 1,
        runId: 'run-1',
        backendId: 'claude',
        resumeHandle: null,
        updatedAtMs: 1000,
        welcomedEpoch: -1,
      })?.welcomedEpoch,
    ).toBeUndefined();
  });
});

describe('buildVoiceAgentRunMetadataV1', () => {
  it('derives backendId from a builtInAgent target and never writes streamId', () => {
    const built = buildVoiceAgentRunMetadataV1({
      runId: 'run-1',
      backendTarget: builtInTarget,
      resumeHandle: null,
      updatedAtMs: 1000,
    });
    expect(built?.backendId).toBe('claude');
    expect(built && 'streamId' in built).toBe(false);
  });

  it('derives backendId from a configuredAcpBackend target', () => {
    const built = buildVoiceAgentRunMetadataV1({
      runId: 'run-1',
      backendTarget: acpTarget,
      resumeHandle: null,
      updatedAtMs: 1000,
    });
    expect(built?.backendId).toBe('gemini-acp');
  });

  it('returns null when runId is empty', () => {
    expect(
      buildVoiceAgentRunMetadataV1({
        runId: '   ',
        backendTarget: builtInTarget,
        resumeHandle: null,
        updatedAtMs: 1000,
      }),
    ).toBeNull();
  });
});

describe('doesVoiceAgentRunMetadataMatchBackendTarget', () => {
  it('matches when an explicit backendTarget matches', () => {
    const metadata = buildVoiceAgentRunMetadataV1({
      runId: 'run-1',
      backendTarget: builtInTarget,
      resumeHandle: null,
      updatedAtMs: 1000,
    });
    expect(doesVoiceAgentRunMetadataMatchBackendTarget(metadata, builtInTarget)).toBe(true);
  });

  it('falls back to backendId when no stored backendTarget', () => {
    const metadata = parseVoiceAgentRunMetadataV1({
      v: 1,
      runId: 'run-1',
      backendId: 'claude',
      resumeHandle: null,
      updatedAtMs: 1000,
    });
    expect(doesVoiceAgentRunMetadataMatchBackendTarget(metadata, builtInTarget)).toBe(true);
    expect(doesVoiceAgentRunMetadataMatchBackendTarget(metadata, acpTarget)).toBe(false);
  });

  it('returns false for null metadata', () => {
    expect(doesVoiceAgentRunMetadataMatchBackendTarget(null, builtInTarget)).toBe(false);
  });
});

describe('isVoiceAgentRunMetadataV1', () => {
  it('is a type guard backed by the parser', () => {
    expect(
      isVoiceAgentRunMetadataV1({
        v: 1,
        runId: 'run-1',
        backendId: 'claude',
        resumeHandle: null,
        updatedAtMs: 1000,
      }),
    ).toBe(true);
    expect(isVoiceAgentRunMetadataV1({ v: 1 })).toBe(false);
  });
});

describe('resolveVoiceAgentRunBackendId', () => {
  it('resolves the concrete id for each target kind', () => {
    expect(resolveVoiceAgentRunBackendId(builtInTarget)).toBe('claude');
    expect(resolveVoiceAgentRunBackendId(acpTarget)).toBe('gemini-acp');
  });
});
