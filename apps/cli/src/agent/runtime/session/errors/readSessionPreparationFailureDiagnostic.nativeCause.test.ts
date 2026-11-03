import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { readSessionPreparationFailureDiagnostic } from './classifyPrimarySessionRuntimeIssue';

it('retains the native startup phase and closed cause in runner file diagnostics', () => {
  const failureCause = { phase: 'client_start', failureReason: 'permission_denied', code: 'EACCES' };
  const error = new PluginError({ code: 'agent_startup_failed', message: '/private/credential PRIVATE_TOKEN',
    details: { failureCause, private: 'PRIVATE_TOKEN' } });
  expect(readSessionPreparationFailureDiagnostic(error)).toMatchObject({
    originalCode: 'agent_startup_failed', failureCause,
  });
  expect(JSON.stringify(readSessionPreparationFailureDiagnostic(error))).not.toMatch(/private|PRIVATE/);
});

it('omits malformed or accessor-backed native causes without reading their values', () => {
  let reads = 0;
  for (const failureCause of [
    { phase: 'client_start', failureReason: 'unknown', code: '/private/credential' },
    { phase: 'client_start', failureReason: 'unknown', private: 'PRIVATE_TOKEN' },
    Object.defineProperty({}, 'phase', { get() { reads++; return 'client_start'; } }),
    { phase: 'client_start', failureReason: 'unknown', preparationCause:
      Object.defineProperty({}, 'code', { get() { reads++; return 'PRIVATE_TOKEN'; } }) },
  ]) {
    const error = new PluginError({ code: 'agent_startup_failed' });
    Object.defineProperty(error, 'details', { value: { failureCause } });
    expect(readSessionPreparationFailureDiagnostic(error)).not.toHaveProperty('failureCause');
  }
  expect(reads).toBe(0);
});
