import {
  databaseActionLocalIdV1,
  TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1,
  TELEMETRY_EXCEPTION_ISSUES_REFRESH_ACTION_ID_V1,
  TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1,
} from '@happier-dev/database-protocol';
import { PluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import { createInMemoryAccountCollection } from '@happier-dev/plugin-sdk/collections';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { TriageGetResultV1Schema, TriageListInstancesResultV1Schema, TriageScanResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { expect, it } from 'vitest';

import { activate, PLUGIN_MANIFEST } from '../manifest.js';
import { activate as activateAccount } from './accountRuntime.js';
import { TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1, type ExceptionIssueRecord } from './issueRecord.js';
import { exceptionLocalRefV1, TELEMETRY_EXCEPTION_SOURCE_DESCRIPTOR_V1, TELEMETRY_EXCEPTION_SOURCE_V1 } from './source.js';

it('reads a Team-shared native issue through the portable runtime without the collector or a reader Machine', async () => {
  const source = PLUGIN_MANIFEST.contributes.targetedPluginContributions.find(
    contribution => contribution.id === TELEMETRY_EXCEPTION_SOURCE_V1.localId,
  );
  const { listInstances, scan, get } = source?.operations ?? {};
  if (!listInstances || !scan || !get) throw new Error('Expected the declared Triage source Actions');
  for (const actionId of [scan, get, listInstances]) {
    expect(PLUGIN_MANIFEST.contributes.actions.find(action => action.id === actionId)?.execution.target, actionId)
      .toBe('account');
  }

  const collectionDefinition = {
    definition: TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1,
    pluginId: PLUGIN_MANIFEST.id,
  };
  const member = createInMemoryAccountCollection(collectionDefinition).collection;
  const owner = createInMemoryAccountCollection(collectionDefinition);
  const shared = {
    rowId: 'shared-issue',
    ownerAccountId: 'owner-account',
    revision: 1,
    access: 'view' as const,
    value: {
      id: 'shared-issue', environmentId: 'production', fingerprint: 'collector-only',
      title: 'Test exception', status: 'open', serviceName: 'api', count: 1, firstSeenAtMs: 1, lastSeenAtMs: 1,
      asOfMs: 1, createdAtMs: 1, updatedAtMs: 1,
    } satisfies ExceptionIssueRecord,
  };
  owner.control.seed(shared.value);
  let granted = true;
  const memberCollection: typeof member = {
    ...member,
    sharing: {
      ...member.sharing,
      async sharedWithMe() { return { rows: granted ? [shared] : [] }; },
      async get({ rowId, ownerAccountId }) {
        if (granted && shared.rowId === rowId && shared.ownerAccountId === ownerAccountId) return shared;
        throw new PluginError({ code: 'collection_unavailable' });
      },
    },
  };
  // The fixture models this plugin's only Collection at the authenticated storage boundary.
  const accountStorage = (collection: typeof member) =>
    ({ account: { collection: () => collection } }) as unknown as PluginServices['storage'];
  const runtime = await createPluginTestkit({
    manifest: PLUGIN_MANIFEST, module: { activate, activateAccount },
    services: { storage: accountStorage(memberCollection) },
  });
  try {
    const { sourceInstanceId, draft } = TELEMETRY_EXCEPTION_SOURCE_DESCRIPTOR_V1.accountDataInstance!;
    const instance = { v: 1, instance: { source: TELEMETRY_EXCEPTION_SOURCE_V1, sourceInstanceId },
      localInstanceKey: draft.localInstanceKey, configuration: draft.configuration, binding: draft.binding } as const;
    const options = { surface: 'plugin', accountScope: { serverId: 'home', accountId: 'member-account' } } as const;
    const localRef = exceptionLocalRefV1(shared.rowId, shared.ownerAccountId);
    const scanResult = (): Promise<unknown> => runtime.invokeAction(scan, { v: 1, instance, page: { kind: 'initial', limit: 10 } }, options);
    const exact = (): Promise<unknown> => runtime.invokeAction(get, { v: 1, instance, localRef }, options);
    expect(TriageListInstancesResultV1Schema.parse(await runtime.invokeAction(listInstances, { v: 1 }, options)))
      .toMatchObject({ kind: 'complete', candidates: [draft] });
    expect(TriageScanResultV1Schema.parse(await scanResult())).toMatchObject({
      kind: 'complete', observations: [{ kind: 'present', localRef }],
    });
    const detail = TriageGetResultV1Schema.parse(await exact());
    expect(detail).toMatchObject({ kind: 'present', localRef, detailData: { environmentId: 'production' } });
    expect(JSON.stringify(detail)).not.toContain('collector-only');
    const detached = await runtime.invokeAction(get, { v: 1, instance, localRef }, { ...options, surface: 'agent' });
    expect(TriageGetResultV1Schema.parse(detached)).toEqual(detail);

    granted = false;
    expect(TriageScanResultV1Schema.parse(await scanResult())).toMatchObject({ kind: 'complete', observations: [] });
    expect(TriageGetResultV1Schema.parse(await exact())).toEqual({ kind: 'absent', localRef });
    const ownerDetail = await runtime.invokeAction(get, {
      v: 1, instance, localRef: exceptionLocalRefV1(shared.rowId),
    }, { ...options, accountScope: { ...options.accountScope, accountId: shared.ownerAccountId },
      services: { storage: accountStorage(owner.collection) } });
    expect(TriageGetResultV1Schema.parse(ownerDetail)).toMatchObject({
      kind: 'present', detailData: { fingerprint: shared.value.fingerprint, status: 'open' },
    });

    const environment = { serverId: options.accountScope.serverId, environmentId: shared.value.environmentId };
    const collectorActions = [
      [TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1, { ...environment, fingerprint: shared.value.fingerprint, page: { limit: 1 } }],
      [TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1, { ...environment, issueId: shared.rowId, action: 'resolve' }],
      [TELEMETRY_EXCEPTION_ISSUES_REFRESH_ACTION_ID_V1, { ...environment, issueId: shared.rowId }],
    ] as const;
    for (const [action, input] of collectorActions) {
      await expect(runtime.invokeAction(databaseActionLocalIdV1(action), input, options))
        .rejects.toMatchObject({ code: 'deployment_target_role_unavailable' });
    }
  } finally {
    await runtime.dispose();
  }
});
