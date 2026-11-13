import { expect, it, onTestFinished, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';
import { createManagedRunLaunchFixture } from '../lifecycle/managedRunLaunch.testkit';
import { createRuntimeProviderSpawnAuthorizationAttempt } from './authorize';

it('retains redacted model projection transport failure detail in the file log before returning the public Provider refusal', async () => {
  const fixture = await createManagedRunLaunchFixture({ remote: true, probeCatalog: true });
  onTestFinished(() => fixture.cleanup());
  // File logging and the exact Machine RPC transport are external boundaries;
  // authorization, catalog selection and the registered Provider stay real.
  const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());
  const transportFailure = Object.assign(new Error('Model projection connection refused; Authorization: Bearer diagnostic-fixture-secret'), {
    code: 'ECONNREFUSED',
  });
  const readModelProjection = vi.fn(async (): Promise<never> => {
    throw new TypeError('Machine RPC failed', { cause: transportFailure });
  });
  const result = await createRuntimeProviderSpawnAuthorizationAttempt({
    selection: { v: 1, updatedAt: 1, ref: {
      agentTargetKey: fixture.agentTargetKey,
      providerConnectionId: ProviderConnectionIdSchema.parse('run-gateway'), modelId: 'model-a',
    } },
    machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey, agentId: fixture.agentId,
    lease: fixture.lease, getAccountSettingsSnapshot: () => fixture.snapshot,
    materializationBaseDir: fixture.happyHomeDir, readModelProjection,
    resolveManagedPurposeBindingIntent: async (): Promise<never> => { throw new Error('No declared purpose'); },
  });

  expect(readModelProjection).toHaveBeenCalled();
  expect(result).toMatchObject({ ok: false, error: { code: 'provider_endpoint_unavailable',
    failureCause: { errorClass: 'TypeError', errorCode: 'ECONNREFUSED' } } });
  expect(JSON.stringify(result)).not.toContain('diagnostic-fixture-secret');
  expect(log).toHaveBeenCalledWith('[PROVIDER] Spawn authorization phase', expect.objectContaining({
    phase: 'model_projection', status: 'failed', reason: 'unclassified',
    providerErrorCode: 'ECONNREFUSED',
    providerErrorMessage: expect.stringContaining('Model projection connection refused'),
  }));
  expect(JSON.stringify(log.mock.calls)).not.toContain('diagnostic-fixture-secret');
});
