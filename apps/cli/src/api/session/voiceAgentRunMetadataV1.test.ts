import { describe, expect, it } from 'vitest';

import {
  mergeVoiceAgentRunMetadataFromExecutionRun,
  VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION,
} from './voiceAgentRunMetadataV1';

describe('mergeVoiceAgentRunMetadataFromExecutionRun', () => {
  it('writes canonical voiceAgentRunV1 metadata from a voice-agent public run', () => {
    const next = mergeVoiceAgentRunMetadataFromExecutionRun({
      metadata: {},
      run: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'side_1',
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
        status: 'running',
        startedAtMs: 100,
        transcript: { persistenceMode: 'persistent', epoch: 11 },
        resumeHandle: {
          kind: 'provider_session.v1',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          providerSessionId: 'vs_1',
        },
      },
      nowMs: 123,
    });

    expect(next).toMatchObject({
      voiceAgentRunV1: {
        v: 1,
        runId: 'run_1',
        backendId: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resumeHandle: {
          kind: 'provider_session.v1',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          providerSessionId: 'vs_1',
        },
        updatedAtMs: 123,
        transcriptContractVersion: VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION,
      },
    });
  });

  it('preserves existing welcomedEpoch and never re-emits a legacy streamId', () => {
    const next = mergeVoiceAgentRunMetadataFromExecutionRun({
      metadata: {
        voiceAgentRunV1: {
          v: 1,
          runId: 'run_old',
          backendId: 'claude',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resumeHandle: {
          kind: 'provider_session.v1',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          providerSessionId: 'vs_old',
        },
          updatedAtMs: 50,
          transcriptContractVersion: 2,
          welcomedEpoch: 9,
          streamId: 'stream_old',
        },
      },
      run: {
        runId: 'run_new',
        callId: 'call_1',
        sidechainId: 'side_1',
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
        status: 'running',
        startedAtMs: 100,
        transcript: { persistenceMode: 'persistent', epoch: 11 },
        resumeHandle: {
          kind: 'provider_session.v1',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          providerSessionId: 'vs_new',
        },
      },
      nowMs: 456,
    });

    const voiceAgentRunV1 = (next as { voiceAgentRunV1: Record<string, unknown> }).voiceAgentRunV1;
    expect(voiceAgentRunV1).toMatchObject({
      runId: 'run_new',
      welcomedEpoch: 9,
    });
    expect('streamId' in voiceAgentRunV1).toBe(false);
  });

  it('updates welcomedEpoch when the daemon welcome path reports a new epoch', () => {
    const next = mergeVoiceAgentRunMetadataFromExecutionRun({
      metadata: {
        voiceAgentRunV1: {
          v: 1,
          runId: 'run_1',
          backendId: 'claude',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          resumeHandle: null,
          updatedAtMs: 50,
          transcriptContractVersion: 2,
        },
      },
      run: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'side_1',
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
        status: 'running',
        startedAtMs: 100,
        transcript: { persistenceMode: 'persistent', epoch: 11 },
      },
      welcomedEpoch: 11,
      nowMs: 789,
    });

    expect(next).toMatchObject({
      voiceAgentRunV1: {
        runId: 'run_1',
        welcomedEpoch: 11,
        updatedAtMs: 789,
      },
    });
  });

  it('rewrites metadata using the canonical contract when the public run is republished', () => {
    const next = mergeVoiceAgentRunMetadataFromExecutionRun({
      metadata: {
      voiceAgentRunV1: {
        v: 1,
        runId: 'run_1',
        backendId: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resumeHandle: {
          kind: 'provider_session.v1',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          providerSessionId: 'vs_1',
        },
        updatedAtMs: 123,
        transcriptContractVersion: 2,
        welcomedEpoch: 11,
      },
      },
      run: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'side_1',
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
        status: 'running',
        startedAtMs: 100,
        transcript: { persistenceMode: 'persistent', epoch: 11 },
        resumeHandle: {
          kind: 'provider_session.v1',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          providerSessionId: 'vs_1',
        },
      },
      welcomedEpoch: 11,
      nowMs: 999,
    });

    expect(next).toMatchObject({
      voiceAgentRunV1: {
        runId: 'run_1',
        updatedAtMs: 999,
        transcriptContractVersion: VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION,
        welcomedEpoch: 11,
      },
    });
  });
});
