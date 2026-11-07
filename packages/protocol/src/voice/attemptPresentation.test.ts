import { describe, expect, it } from 'vitest';
import { VoiceAttemptPresentationSchema } from './attemptPresentation.js';
import { VoiceConversationStatusSchema } from '../actions/voiceConversationActionFamily.js';

describe('Voice attempt public presentation', () => {
  const input = {
    attemptId: 'attempt', surfaceState: 'error', live: true, muted: false,
    canStart: false, canStop: false, canMute: false, canCommitInput: false,
    canDismissFailedAttempt: true, canDismissEnded: false,
    failureKind: 'authentication_required', failureMessage: 'Sign in required',
    recovery: { action: 'connect_agent', label: 'Set up Agent', icon: 'gear', runtimeTarget: {
      agentId: 'external-agent', pluginId: 'example.agent', machineId: 'machine', serverIdentityId: 'home',
    } },
  };
  it('admits the host failure and exact recovery target while rejecting extra private facts at each boundary', () => {
    expect(VoiceAttemptPresentationSchema.parse(input)).toEqual(input);
    expect(VoiceAttemptPresentationSchema.safeParse({ ...input, errorMessage: '/private/provider/detail' }).success).toBe(false);
    expect(VoiceAttemptPresentationSchema.safeParse({ ...input, recovery: { ...input.recovery, credential: 'private' } }).success).toBe(false);
    expect(VoiceAttemptPresentationSchema.safeParse({ ...input, recovery: { ...input.recovery, runtimeTarget: {
      ...input.recovery.runtimeTarget, accountId: 'injected',
    } } }).success).toBe(false);
    expect(VoiceAttemptPresentationSchema.safeParse({ ...input, failureKind: 'provider_native_private_failure' }).success).toBe(false);
  });
  it('carries the same presentation through the public Action read without allowing private fields', () => {
    const status = {
      attemptId: 'attempt', adapterId: 'example.voice/realtime', sessionId: 'control', status: 'error', mode: 'idle',
      target: { kind: 'global' }, conversationSessionAddress: null, targetSessionAddress: null,
      canStart: false, canStop: false, canMute: false, canCommitInput: false, canHoldToTalk: false,
      muted: false, canDismissFailedAttempt: true, canDismissEnded: false,
      recoveryAction: 'connect_agent', availability: 'recoverable', inUseVoice: null,
    };
    expect(VoiceConversationStatusSchema.safeParse(status).success).toBe(true);
    expect(VoiceConversationStatusSchema.parse({ ...status, presentation: input })).toMatchObject({ presentation: input });
    expect(VoiceConversationStatusSchema.parse({
      ...status, status: 'connected', mode: 'idle',
      presentation: { ...input, surfaceState: 'live', failureKind: null, failureMessage: null, recovery: null },
    })).toMatchObject({ status: 'connected', mode: 'idle', presentation: { surfaceState: 'live' } });
    expect(VoiceConversationStatusSchema.safeParse({ ...status, presentation: { ...input, errorMessage: 'private' } }).success).toBe(false);
  });
});
