import { describe, expect, it } from 'vitest';

import {
  SPAWN_SESSION_ERROR_CODES,
  SPAWN_SESSION_ERROR_DETAIL_KINDS,
  isConnectedServiceResumeUnreachableSpawnErrorDetail,
} from '@happier-dev/protocol';

import { ConnectedServiceSpawnResumeUnreachableError } from './resolveConnectedServiceAuthForSpawn';
import { buildSpawnResumeUnreachableErrorResult } from './buildSpawnResumeUnreachableErrorResult';

function makeError() {
  return new ConnectedServiceSpawnResumeUnreachableError({
    agentId: 'pi',
    vendorResumeId: 'pi-session-missing',
    cwd: '/tmp/project',
    targetMaterializedRoot: '/tmp/materialized/pi-agent-dir',
    reason: 'no_resumable_session_file',
  });
}

describe('buildSpawnResumeUnreachableErrorResult', () => {
  it('preserves the SPAWN_VALIDATION_FAILED code and a verbatim message for legacy consumers', () => {
    const error = makeError();
    const result = buildSpawnResumeUnreachableErrorResult(error);

    expect(result.type).toBe('error');
    expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED);
    // The human-readable message still carries the continuity code + phase so existing
    // copy-based surfaces keep working.
    expect(result.errorMessage).toContain('provider_session_state_unavailable_for_resume');
    expect(result.errorMessage).toContain('continuity');
    expect(result.errorMessage).not.toContain('pi-session-missing');
    expect(result.errorMessage).not.toContain('/tmp/project');
    expect(result.errorMessage).not.toContain('/tmp/materialized/pi-agent-dir');
  });

  it('attaches a UI-safe connected-service resume-unreachable detail', () => {
    const error = makeError();
    const result = buildSpawnResumeUnreachableErrorResult(error);

    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)).toBe(true);
    expect(result.errorDetail).toMatchObject({
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
      continuityErrorCode: 'provider_session_state_unavailable_for_resume',
      failurePhase: 'continuity',
      agentId: 'pi',
      reason: 'no_resumable_session_file',
    });
    expect(result.errorDetail).not.toHaveProperty('vendorResumeId');
    expect(result.errorDetail).not.toHaveProperty('cwd');
    expect(result.errorDetail).not.toHaveProperty('targetMaterializedRoot');
    if (!isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)) {
      throw new Error('expected resume-unreachable detail');
    }
    expect(result.errorDetail.uxDiagnostic.code).toBe('provider_session_state_unavailable_for_resume');
    expect(result.errorDetail.uxDiagnostic.diagnostics?.reason).toBe('no_resumable_session_file');
  });

  it('keeps unresolved materialized-root information out of the public detail', () => {
    const error = new ConnectedServiceSpawnResumeUnreachableError({
      agentId: 'codex',
      vendorResumeId: 'rollout-123',
      cwd: '/work/repo',
      targetMaterializedRoot: null,
      reason: 'native_session_file_missing',
    });
    const result = buildSpawnResumeUnreachableErrorResult(error);

    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)).toBe(true);
    if (!isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)) {
      throw new Error('expected resume-unreachable detail');
    }
    expect(result.errorDetail).not.toHaveProperty('targetMaterializedRoot');
    expect(result.errorDetail).not.toHaveProperty('vendorResumeId');
    expect(result.errorDetail).not.toHaveProperty('cwd');
    expect(result.errorDetail.agentId).toBe('codex');
  });

  it('does not publish a provider resume id echoed by an untrusted reachability reason', () => {
    const error = new ConnectedServiceSpawnResumeUnreachableError({
      agentId: 'pi',
      vendorResumeId: 'pi-private-resume-identity',
      cwd: '/work/private-project',
      targetMaterializedRoot: '/work/private-project/.pi',
      reason: 'pi-private-resume-identity',
    });

    const result = buildSpawnResumeUnreachableErrorResult(error);
    const publicPayload = JSON.stringify(result);

    expect(publicPayload).not.toContain('pi-private-resume-identity');
    expect(publicPayload).not.toContain('/work/private-project');
    if (!isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)) {
      throw new Error('expected resume-unreachable detail');
    }
    expect(result.errorDetail.reason).toBe('resume_reachability_unavailable');
  });
});
