import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { duplicateRemoteHostForActionV1, changeRemoteHostCredentialForActionV1 } from '@happier-dev/protocol/remoteHosts/remoteHostActionsV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCliRemoteHostStore, createCliRemoteHostStoreForOperation } from '@/settings/remoteHosts/remoteHostStore';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';

/** Account catalog Actions use the invocation's issued Home, never the ambient Home. */
export function createCliRemoteHostActionExecuteV1(params: Readonly<{
  credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string;
  operationContext?: SavedSecretOperationContextV1;
}>): NonNullable<ActionExecutorDeps['remoteHostActionExecute']> {
  return async (request, context) => runWithServerHttpBaseUrl(params.serverHttpBaseUrl, async () => {
    if (context.serverId && context.serverId !== params.serverId) {
      return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
    }
    if (!params.operationContext && !getActiveAccountSettingsSnapshot()) {
      await bootstrapAccountSettingsContext({ credentials: params.credentials, mode: 'blocking' });
    }
    const store = params.operationContext
      ? createCliRemoteHostStoreForOperation({ operationContext: params.operationContext, signal: context.signal })
      : createCliRemoteHostStore({ credentials: params.credentials, signal: context.signal });
    store.assertCurrent();
    if (request.actionId === 'remote_hosts.save') return { ok: true, result: await store.saveHost(request.input) };
    const catalog = await store.readCatalogForOperation();
    store.assertCurrent();
    if (catalog.status !== 'ready' && catalog.status !== 'partial') return { ok: true, result: {
      status: 'unavailable', reason: catalog.status === 'unavailable' ? catalog.reason : 'remote_host_catalog_loading',
    } };
    if (request.actionId === 'remote_hosts.list') return { ok: true, result: {
      status: 'listed', hosts: catalog.hosts, revision: catalog.revision, complete: catalog.status === 'ready',
    } };
    if (request.actionId === 'remote_hosts.read') {
      const host = catalog.hosts.find(host => host.id === request.input.hostId);
      return { ok: true, result: host ? { status: 'present', host, revision: catalog.revision }
        : { status: 'unavailable', reason: catalog.status === 'partial' ? 'remote_host_catalog_incomplete' : 'remote_host_not_found' } };
    }
    if (request.actionId !== 'remote_hosts.delete' && request.actionId !== 'remote_hosts.duplicate'
      && request.actionId !== 'remote_hosts.credential.change') {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    }
    if (catalog.status !== 'ready') return { ok: true, result: { status: 'unavailable', reason: 'remote_host_catalog_incomplete' } };
    if (catalog.revision !== request.input.expectedRevision) return { ok: true, result: {
      status: 'conflict', revision: catalog.revision === 'absent' ? -1 : catalog.revision,
    } };
    const host = catalog.hosts.find(host => host.id === request.input.hostId);
    if (!host) return { ok: true, result: { status: 'unavailable', reason: 'remote_host_not_found' } };
    if (request.actionId === 'remote_hosts.delete') return { ok: true, result: await store.removeHost(request.input) };
    if (request.actionId === 'remote_hosts.duplicate') {
      if (catalog.hosts.some(host => host.id === request.input.newHostId)) {
        return { ok: true, result: { status: 'unavailable', reason: 'remote_host_duplicate_identity' } };
      }
      return { ok: true, result: await store.saveHost({
        host: duplicateRemoteHostForActionV1(host, { ...request.input, now: Date.now() }),
        expectedRevision: request.input.expectedRevision,
      }) };
    }
    const credential = request.input.credential;
    const resource = credential.kind === 'password' || credential.kind === 'private_key' ? credential : null;
    return { ok: true, result: await store.saveHost({
      host: changeRemoteHostCredentialForActionV1(host, credential, Date.now()), expectedRevision: request.input.expectedRevision,
      ...(resource ? { referencedSavedSecretRevisions: [{ resourceId: resource.resourceId, revision: resource.expectedResourceRevision }] } : {}),
    }) };
  });
}
