import { describe, expect, it } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

import {
  resolveSessionRunnerRestartEligibility,
  shouldRefreshSessionRunnerResumeIdentity,
} from './resolveRestartEligibility';

function trackedRunner(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    trackingKey: legacyPidSessionTrackingKey(overrides.pid ?? 4242),
    pid: 4242,
    happySessionId: 'sess-1',
    startedBy: 'daemon',
    processCommand:
      'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs codex --happy-starting-mode remote --started-by daemon',
    processCommandHash: 'command-hash',
    processStartTimeMs: 12_345,
    vendorResumeId: 'vendor-thread-1',
    spawnOptions: {
      directory: '/workspace',
      resume: 'vendor-thread-1',
    },
    ...overrides,
  };
}

describe('resolveSessionRunnerRestartEligibility', () => {
  it('exposes an observed unsupported restart handshake as a recovery refusal', () => {
    expect(resolveSessionRunnerRestartEligibility(trackedRunner({ runnerRestartAdmissionUnsupportedPid: 4242 })))
      .toEqual({ eligible: false, disabledReason: 'restart_admission_unsupported' });
    expect(resolveSessionRunnerRestartEligibility(trackedRunner({
      sessionRunnerPid: 4243, runnerRestartAdmissionUnsupportedPid: 4243,
      runnerProcessIdentity: { pid: 4243, processStartTimeMs: 12_346, processCommandHash: 'command-hash',
        processCommand: trackedRunner().processCommand },
    }))).toEqual({ eligible: false, disabledReason: 'restart_admission_unsupported' });
    expect(resolveSessionRunnerRestartEligibility(trackedRunner({
      sessionRunnerPid: 4243, runnerRestartAdmissionUnsupportedPid: 4242,
      runnerProcessIdentity: { pid: 4243, processStartTimeMs: 12_346, processCommandHash: 'command-hash',
        processCommand: trackedRunner().processCommand },
    }))).toEqual({ eligible: true, disabledReason: null });
    expect(resolveSessionRunnerRestartEligibility(trackedRunner()))
      .toEqual({ eligible: true, disabledReason: null });
  });
  it.each(['windows_terminal', 'console'] as const)('retains resume refusal precedence for a %s hosted runner', windowsRemoteSessionLaunchMode => {
    const spawnOptions = { directory: '/workspace', windowsRemoteSessionLaunchMode };
    expect(resolveSessionRunnerRestartEligibility(trackedRunner({ spawnOptions, vendorResumeId: undefined })))
      .toEqual({ eligible: false, disabledReason: 'missing_resume_identity' });
    expect(resolveSessionRunnerRestartEligibility(trackedRunner({ spawnOptions })))
      .toEqual({ eligible: false, disabledReason: 'windows_hosted_runner' });
  });
  it('refuses non-daemon launches before evaluating resume or process witnesses', () => {
    expect(resolveSessionRunnerRestartEligibility(trackedRunner({ startedBy: 'terminal' })))
      .toEqual({ eligible: false, disabledReason: 'not_daemon_started' });
  });
  it('accepts the Agent resume id byte-exact and rejects whitespace-only identity', () => {
    const exactResume = '  provider\nses/AB+cd==  ';
    const eligible = { eligible: true, disabledReason: null };
    const missing = { eligible: false, disabledReason: 'missing_resume_identity' };

    expect(resolveSessionRunnerRestartEligibility(trackedRunner({
      vendorResumeId: undefined,
      spawnOptions: { directory: '/workspace', resume: exactResume },
    }))).toEqual(eligible);
    expect(resolveSessionRunnerRestartEligibility(trackedRunner({
      vendorResumeId: exactResume,
      spawnOptions: { directory: '/workspace' },
    }))).toEqual(eligible);
    expect(resolveSessionRunnerRestartEligibility(trackedRunner({
      vendorResumeId: '   ',
      spawnOptions: { directory: '/workspace', resume: ' \n ', existingSessionId: '  ' },
    }))).toEqual(missing);
  });

  it.each([
    ['missing command hash', { processCommandHash: undefined }],
    ['blank command hash', { processCommandHash: '   ' }],
    ['predecessor-reattached runner missing process birth', { processStartTimeMs: undefined }],
    ['non-finite process birth', { processStartTimeMs: Number.POSITIVE_INFINITY }],
  ] satisfies ReadonlyArray<readonly [string, Partial<TrackedSession>]>) (
    'fails closed with the existing unsupported reason for %s',
    (_label, overrides) => {
      expect(resolveSessionRunnerRestartEligibility(
        trackedRunner(overrides),
      )).toEqual({
        eligible: false,
        disabledReason: 'non_destructive_refresh_unsupported',
      });
    },
  );
});

describe('shouldRefreshSessionRunnerResumeIdentity', () => {
  it('excludes runners whose cold-resume contract is unsupported even when no identity is tracked', () => {
    const missingIdentity = trackedRunner({
      vendorResumeId: undefined,
      spawnOptions: { directory: '/workspace' },
    });
    expect(shouldRefreshSessionRunnerResumeIdentity(missingIdentity)).toBe(true);
    expect(shouldRefreshSessionRunnerResumeIdentity({
      ...missingIdentity,
      agentSessionStartupInstructionsMarkerV1: {
        v: 1,
        id: 'happier.global_voice_agent',
        revision: 7,
      },
    })).toBe(false);
  });
});
