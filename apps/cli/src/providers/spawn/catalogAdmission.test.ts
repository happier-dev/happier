import { SPAWN_SESSION_ERROR_DETAIL_KINDS } from '@happier-dev/protocol/spawnSession';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { SessionRuntimeFailureCauseV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { buildProviderSpawnErrorResult } from '@/daemon/spawn/buildProviderSpawnErrorResult';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, type ProviderConnectionsCatalogSnapshotV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderOperationLifetime } from '../operationLifetime';
import { readProviderSpawnCatalogSnapshot } from './catalogAdmission';

it.each([
  ['unreachable', 'provider_catalog_unavailable'],
  ['scope-retired', 'provider_authorization_changed'],
  ['invalid-stored-content', 'provider_settings_invalid'],
] as const)('preserves retained catalog settlement %s separately from invalid settings', async (reason, code) => {
  const result = await readProviderSpawnCatalogSnapshot({
    readSnapshot: () => ({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: 'account', providerConnectionsCatalog: { status: 'unavailable', reason } }),
    expectedScopeKey: 'account', lifetime: createProviderOperationLifetime({}), connectionId: null, machineId: 'machine',
  });
  expect(result).toMatchObject({ ok: false, error: { code, failureCause: { phase: 'providers.catalog', errorCode: reason } } });
});
it('consumes a ready retained catalog without a transport read', async () => {
  const catalog: ProviderConnectionsCatalogSnapshotV1 = { status: 'ready', revision: 1, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 };
  const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
    scopeKey: 'account', providerConnectionsCatalog: catalog };
  expect(await readProviderSpawnCatalogSnapshot({ readSnapshot: () => snapshot, expectedScopeKey: 'account',
    lifetime: createProviderOperationLifetime({}), connectionId: null, machineId: 'machine' })).toEqual({ ok: true, snapshot });
});

// Exercise the actual spawn envelope and runtime consumer; Action causes use a different vocabulary.
it.each(['direct', 'execution-run'] as const)('preserves a catalog refusal through spawn and runtime republication: %s', envelope => {
  const error = createProviderErrorV1('provider_catalog_unavailable', { failureCause: {
    phase: 'providers.catalog', errorClass: 'Error', errorCode: 'unreachable', httpStatus: null,
  } });
  const spawn = buildProviderSpawnErrorResult(error);
  expect(spawn.errorDetail).toMatchObject({ kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.PROVIDER_ERROR, providerError: error });
  if (spawn.errorDetail?.kind !== SPAWN_SESSION_ERROR_DETAIL_KINDS.PROVIDER_ERROR) throw new Error('Expected Provider refusal');
  const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'pi', occurredAt: 100, error: envelope === 'direct' ? spawn.errorDetail.providerError
    : Object.assign(new Error(error.code), { code: error.code, details: { providerError: spawn.errorDetail.providerError } }) });
  expect(issue).toMatchObject({ code: 'provider_catalog_unavailable', failureCause: {
    code: 'provider_catalog_unavailable', phase: 'client_start', failureReason: 'unknown', providerErrorCode: 'unreachable',
  } });
  expect(SessionRuntimeFailureCauseV1Schema.safeParse(issue.failureCause).success).toBe(true);
  expect(issue.sanitizedPreview.toLowerCase()).toContain('catalog');
  expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'pi', occurredAt: 100,
    error: { code: issue.code, details: { v: 1, source: issue.source, failureCause: issue.failureCause } } })).toEqual(issue);
});
