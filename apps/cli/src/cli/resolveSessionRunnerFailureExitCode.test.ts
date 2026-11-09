import { expect, it, vi } from 'vitest';

import { reportSessionRunnerFailure } from './resolveSessionRunnerFailureExitCode';
import { logger } from '@/ui/logger';
import { PluginError } from '@happier-dev/plugin-sdk';

it.each(['plugin_mcp_preparation_unavailable', 'agent_runtime_daemon_service_generation_not_current',
  'native_agent_privileged_effect_authority_unavailable', 'native_agent_privileged_effect_outcome_unknown',
  'skills_unavailable', 'team_credential_provider_selection_not_current', 'provider_compatibility_unverified',
  'provider_endpoint_unavailable', 'agent_startup_model_reconciliation_failed'])('retains only the closed startup refusal %s', code => {
  const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
  const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
  try {
    expect(reportSessionRunnerFailure(new PluginError({ code, message: 'PRIVATE_BODY', details: { secret: 'PRIVATE_TOKEN' } })))
      .toBe(code === 'provider_compatibility_unverified' ? 79 : 1);
    expect(log).toHaveBeenLastCalledWith('[Session] Runner failed', expect.objectContaining({ errorCode: code }));
    reportSessionRunnerFailure(new PluginError({ code: `${code}_PRIVATE`, message: 'PRIVATE_BODY' }));
    expect(log).toHaveBeenLastCalledWith('[Session] Runner failed', expect.objectContaining({ errorCode: null }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE/);
  } finally { log.mockRestore(); fatal.mockRestore(); }
});

it('records code-only phase evidence for a refused continuation before exit 78', () => {
  const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
  const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
  const error = Object.assign(new Error('private-body\n    at /PRIVATE_SENTINEL.js:1:2'), {
    name: 'AgentSessionContinuationUnreachableError',
    response: { status: 503, data: 'private-response', headers: { Authorization: 'private-token' } },
  });
  try {
    expect(reportSessionRunnerFailure(error)).toBe(78);
    expect(log).toHaveBeenCalledWith('[Session] Runner failed', expect.objectContaining({
      phase: 'runner_exit', exitCode: 78, errorClass: 'Error', httpStatus: 503,
      stackFrames: expect.arrayContaining([expect.objectContaining({
        file: expect.stringContaining('resolveSessionRunnerFailureExitCode.test.ts'),
      })]),
    }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-|PRIVATE_SENTINEL/);
  } finally { log.mockRestore(); fatal.mockRestore(); }
});
