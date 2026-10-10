import { router } from 'expo-router';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { duplicateRemoteHostForActionV1, changeRemoteHostCredentialForActionV1 } from '@happier-dev/protocol/remoteHosts/remoteHostActionsV1';
import type { RemoteHostRecordV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { getDefaultSystemTaskRunner } from '@/components/systemTasks';
import { REMOTE_HOSTS_NEW_ROUTE, remoteHostHref } from '@/components/settings/remoteHosts/collection/remoteHostsRoutes';
import { startRemoteHostMaintenanceTask, startRemoteHostSetupTask, connectRemoteHostFromDevice,
    startAdmittedRemoteHostSystemTask, resolveRemoteHostRelayAccess, type RemoteHostMaintenanceTaskAction } from '@/components/settings/remoteHosts/remoteHostTaskOperations';
import { buildRelayAccessStatusSystemTaskSpec, buildRelayAccessDisableSystemTaskSpec, buildRelayAccessExecutionSystemTaskSpec } from '@/components/systemTasks/specs/relayAccess/buildRelayAccessSystemTaskSpec';
import { readRemoteHostCatalogForOperationInContext, saveRemoteHostInContext, removeRemoteHostInContext } from '@/sync/api/account/apiRemoteHostCatalog';
import { readSavedSecretReferenceInContext } from '@/sync/api/account/apiSavedSecretCatalog';
import { resolveRemoteHostEffectiveSshConfig } from '@/sync/domains/remoteHosts/resolveRemoteHostEffectiveSshConfig';
import { getRemoteHostLocalOverrides } from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveRuntimeFeatureDecisionFromSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';
import { getRemoteHostTrustedHostKeyStore } from '@/sync/domains/remoteHosts/hostKeys/trustedHostKeyStore';
import { getNativeSshTunnelRuntime } from '@/sync/runtime/nativeSshTunnels/runtime';
import { buildSshTunnelStopSystemTaskSpec } from '@/components/systemTasks/specs/localControl/buildSshTunnelSystemTaskSpec';

export const REMOTE_HOST_MAINTENANCE_ACTION_IDS = {
    testConnection: 'remote_hosts.relay.test',
    installOrUpdateCli: 'remote_hosts.cli.install_or_update',
    'daemonService.installOrUpdate': 'remote_hosts.daemon.install_or_update',
    'daemonService.start': 'remote_hosts.daemon.start',
    'daemonService.stop': 'remote_hosts.daemon.stop',
    'daemonService.restart': 'remote_hosts.daemon.restart',
    'relayRuntime.status': 'remote_hosts.relay.status',
    'relayRuntime.installOrUpdate': 'remote_hosts.relay.install_or_update',
    'relayRuntime.start': 'remote_hosts.relay.start',
    'relayRuntime.stop': 'remote_hosts.relay.stop',
    'relayRuntime.restart': 'remote_hosts.relay.restart',
    'personalHome.erase': 'remote_hosts.personal_home.erase',
} as const;

class RemoteHostOperationError extends Error {
    constructor(readonly reason: string, readonly revision?: number) { super(reason); }
}

async function requireAdmittedHost(account: LazyActionAccountContext, input: Readonly<{
    hostId: string; expectedRevision: number | 'absent';
}>, signal?: AbortSignal) {
    const catalog = await readRemoteHostCatalogForOperationInContext(account, signal);
    if (catalog.status !== 'ready') throw new RemoteHostOperationError(catalog.status === 'unavailable' ? catalog.reason : 'remote_host_catalog_incomplete');
    if (catalog.revision !== input.expectedRevision) throw new RemoteHostOperationError('remote_host_changed', catalog.revision === 'absent' ? -1 : catalog.revision);
    const host = catalog.hosts.find(host => host.id === input.hostId);
    if (!host) throw new RemoteHostOperationError('remote_host_not_found');
    return host;
}

export async function withRemoteHostSshConfig<T>(account: LazyActionAccountContext, input: Readonly<{
    hostId: string; expectedRevision: number | 'absent';
}>, operation: (input: Readonly<{
    host: RemoteHostRecordV1; config: Awaited<ReturnType<typeof resolveRemoteHostEffectiveSshConfig>> & { ok: true };
    assertCurrent(): void;
}>) => Promise<T>, signal?: AbortSignal): Promise<T> {
    account.assertCurrent();
    if (!areServerAccountScopesEqual(getActiveServerAccountScope(), account.accountLifetime.scope)) throw new RemoteHostOperationError('active_home_required');
    const host = await requireAdmittedHost(account, input, signal);
    const [settings, snapshot] = await Promise.all([account.readSettings(), getServerFeaturesSnapshot({ serverId: account.serverId })]);
    const enabled = (featureId: 'remoteHosts.management' | 'remoteHosts.secretMaterial') => resolveRuntimeFeatureDecisionFromSnapshot({
        featureId, settings, snapshot, scope: { scopeKind: 'spawn', serverId: account.serverId },
    })?.state === 'enabled';
    if (!enabled('remoteHosts.management')) throw new RemoteHostOperationError('remote_host_management_unavailable');
    const assertCurrent = () => { signal?.throwIfAborted(); account.assertCurrent(); };
    const config = await resolveRemoteHostEffectiveSshConfig({ remoteHost: host,
        localOverrides: getRemoteHostLocalOverrides(host.id), secretMaterialAllowed: enabled('remoteHosts.secretMaterial'),
        readSavedSecretValue: reference => readSavedSecretReferenceInContext(account, reference, signal) });
    assertCurrent();
    if (!config.ok) throw new RemoteHostOperationError(config.error.code);
    // Materialization crosses a transport boundary; the addressed row must still
    // be the captured revision before those credentials can reach SSH.
    await requireAdmittedHost(account, input, signal);
    assertCurrent();
    return operation({ host, config, assertCurrent });
}

/** The current relay dialog borrows credentials only until its admitted runner accepts the task. */
export async function runRemoteHostRelayAccessTask<T>(input: Readonly<{
    scope: ServerAccountScope; hostId: string; expectedRevision: number | 'absent'; signal?: AbortSignal;
    run(target: RelayAccessTaskTarget, upstreamUrl: string | null, assertCurrent: () => void): Promise<T>;
}>): Promise<T> {
    const account = await captureLazyActionAccountContext(input.scope.serverId, input.signal);
    try {
        if (!areServerAccountScopesEqual(account.accountLifetime.scope, input.scope)) throw new RemoteHostOperationError('action_account_scope_changed');
        return await withRemoteHostSshConfig(account, input, async ({ config, assertCurrent }) => {
            const relay = resolveRemoteHostRelayAccess({ config: config.value, homeTarget: await account.resolveHomeTarget() });
            if (relay.status !== 'relay_ready') throw new RemoteHostOperationError(relay.reason);
            assertCurrent();
            return input.run(relay.target, relay.upstreamUrl, assertCurrent);
        }, input.signal);
    } finally { account.dispose(); }
}

/** Typed automation and menus consume the same catalog and existing admitted SSH task owner. */
export function createUiRemoteHostActionExecuteV1(account: LazyActionAccountContext,
    openRoute: (route: string) => void | Promise<void> = route => router.push(route as never)): NonNullable<ActionExecutorDeps['remoteHostActionExecute']> {
    return async (request, context) => {
        const scope = account.accountLifetime.scope;
        const assertCurrent = () => { context.signal?.throwIfAborted(); account.assertCurrent(); };
        const openEditorRoute = async (route: string) => {
            const assertEditorCurrent = () => {
                assertCurrent();
                if (!areServerAccountScopesEqual(getActiveServerAccountScope(), scope)) throw new RemoteHostOperationError('active_home_required');
            };
            assertEditorCurrent();
            const opened = await runGuardedNavigation(() => { assertEditorCurrent(); return openRoute(route); });
            if (!opened) throw new RemoteHostOperationError('navigation_cancelled');
        };
        const mutationResult = (hostId: string, result: Awaited<ReturnType<typeof saveRemoteHostInContext>>) => result.ok
            ? { status: 'updated' as const, hostId, revision: result.revision }
            : result.reason === 'outcome_unknown' ? { status: 'outcome_unknown' as const }
            : { status: 'unavailable' as const, reason: result.reason };
        try {
            assertCurrent();
            if (request.actionId === 'remote_hosts.tunnel.stop') {
                if (request.input.target.kind === 'native') {
                    await getNativeSshTunnelRuntime().releaseTunnel(request.input.target.leaseId);
                    return { ok: true, result: { status: 'released' } };
                }
                const runner = getDefaultSystemTaskRunner();
                if (runner.mode !== 'tauri') throw new RemoteHostOperationError('desktop_host_required');
                const taskId = await runner.start(buildSshTunnelStopSystemTaskSpec(request.input.target.tunnelKey));
                return { ok: true, result: { status: 'task_started', taskId } };
            }
            if (request.actionId === 'remote_hosts.trusted_keys.list' || request.actionId === 'remote_hosts.trusted_keys.remove'
                || request.actionId === 'remote_hosts.trusted_keys.clear') {
                const store = getRemoteHostTrustedHostKeyStore();
                if (request.actionId === 'remote_hosts.trusted_keys.list') return { ok: true, result: { status: 'listed',
                    keys: store.readAll().map(key => ({ host: key.hostLower, port: key.port, algorithm: key.algorithm, fingerprintSha256: key.fingerprintSha256 })) } };
                if (request.actionId === 'remote_hosts.trusted_keys.remove') {
                    const key = store.get(request.input.key);
                    if (!key || key.fingerprintSha256 !== request.input.key.fingerprintSha256) throw new RemoteHostOperationError('trusted_host_key_changed');
                    assertCurrent();
                    store.delete(request.input.key);
                } else {
                    const records = store.readAll();
                    const reviewed = new Set(request.input.keys.map(key => {
                        const current = store.get(key);
                        if (!current || current.fingerprintSha256 !== key.fingerprintSha256) throw new RemoteHostOperationError('trusted_host_keys_changed');
                        return JSON.stringify([current.hostLower, current.port, current.algorithm]);
                    }));
                    if (reviewed.size !== records.length) throw new RemoteHostOperationError('trusted_host_keys_changed');
                    assertCurrent();
                    store.clear();
                }
                return { ok: true, result: { status: 'removed' } };
            }
            if (request.actionId === 'remote_hosts.save') {
                return { ok: true, result: mutationResult(request.input.host.id, await saveRemoteHostInContext(account, request.input, context.signal)) };
            }
            if (request.actionId === 'remote_hosts.add') {
                await openEditorRoute(REMOTE_HOSTS_NEW_ROUTE);
                return { ok: true, result: { status: 'opened', route: REMOTE_HOSTS_NEW_ROUTE } };
            }
            if (request.actionId === 'remote_hosts.list' || request.actionId === 'remote_hosts.read') {
                const catalog = await readRemoteHostCatalogForOperationInContext(account, context.signal);
                assertCurrent();
                if (catalog.status !== 'ready' && catalog.status !== 'partial') throw new RemoteHostOperationError(catalog.status === 'unavailable' ? catalog.reason : 'remote_host_catalog_loading');
                if (request.actionId === 'remote_hosts.list') return { ok: true, result: {
                    status: 'listed', hosts: catalog.hosts, revision: catalog.revision, complete: catalog.status === 'ready',
                } };
                const host = catalog.hosts.find(host => host.id === request.input.hostId);
                return { ok: true, result: host ? { status: 'present', host, revision: catalog.revision }
                    : { status: 'unavailable', reason: catalog.status === 'partial' ? 'remote_host_catalog_incomplete' : 'remote_host_not_found' } };
            }
            const host = await requireAdmittedHost(account, request.input, context.signal);
            assertCurrent();
            if (request.actionId === 'remote_hosts.delete') return { ok: true, result: mutationResult(host.id,
                await removeRemoteHostInContext(account, request.input, context.signal)) };
            if (request.actionId === 'remote_hosts.duplicate') {
                const catalog = await readRemoteHostCatalogForOperationInContext(account, context.signal);
                assertCurrent();
                if (catalog.status !== 'ready') throw new RemoteHostOperationError('remote_host_catalog_incomplete');
                if (catalog.hosts.some(entry => entry.id === request.input.newHostId)) throw new RemoteHostOperationError('remote_host_duplicate_identity');
                const now = Date.now();
                return { ok: true, result: mutationResult(request.input.newHostId, await saveRemoteHostInContext(account, {
                    host: duplicateRemoteHostForActionV1(host, { ...request.input, now }), expectedRevision: request.input.expectedRevision,
                }, context.signal)) };
            }
            if (request.actionId === 'remote_hosts.credential.change') {
                const credential = request.input.credential;
                const resource = credential.kind === 'password' || credential.kind === 'private_key' ? credential : null;
                const updated = changeRemoteHostCredentialForActionV1(host, credential, Date.now());
                return { ok: true, result: mutationResult(host.id, await saveRemoteHostInContext(account, {
                    host: updated, expectedRevision: request.input.expectedRevision,
                    ...(resource ? { referencedSavedSecretRevisions: [{ resourceId: resource.resourceId, revision: resource.expectedResourceRevision }] } : {}),
                }, context.signal)) };
            }
            if (request.actionId === 'remote_hosts.edit' || request.actionId === 'remote_hosts.relay.use') {
                const route = remoteHostHref(host.id) + (request.actionId === 'remote_hosts.edit' ? ''
                    : `?remoteHostIntent=relay&expectedRevision=${encodeURIComponent(String(request.input.expectedRevision))}`);
                await openEditorRoute(route);
                return { ok: true, result: { status: 'opened', route, hostId: host.id } };
            }
            return { ok: true, result: await withRemoteHostSshConfig(account, request.input, async ({ config, host, assertCurrent }) => {
                const runner = getDefaultSystemTaskRunner();
                const admission = { runner, config: config.value, assertCurrent, signal: context.signal };
                if (request.actionId === 'remote_hosts.relay.access.status') {
                    const relay = resolveRemoteHostRelayAccess({ config: config.value, homeTarget: await account.resolveHomeTarget() });
                    if (relay.status !== 'relay_ready') throw new RemoteHostOperationError(relay.reason);
                    return startAdmittedRemoteHostSystemTask(admission, buildRelayAccessStatusSystemTaskSpec({ target: relay.target }));
                }
                if (request.actionId === 'remote_hosts.relay.configure') {
                    const relay = resolveRemoteHostRelayAccess({ config: config.value, homeTarget: await account.resolveHomeTarget() });
                    if (relay.status !== 'relay_ready') throw new RemoteHostOperationError(relay.reason);
                    const operation = request.input.operation;
                    const spec = operation.kind === 'disable'
                        ? buildRelayAccessDisableSystemTaskSpec({ target: relay.target })
                        : buildRelayAccessExecutionSystemTaskSpec({ target: relay.target,
                            providerId: operation.config.providerId, config: operation.config, upstreamUrl: relay.upstreamUrl });
                    return startAdmittedRemoteHostSystemTask(admission, spec);
                }
                if (request.actionId === 'remote_hosts.connect') {
                    if (runner.mode === 'native' && getFeatureBuildPolicyDecision('setup.ssh.nativeTransport') === 'deny') {
                        throw new RemoteHostOperationError('native_ssh_tunnel_unavailable');
                    }
                    return connectRemoteHostFromDevice({ ...admission, remoteHostId: host.id, serverId: account.serverId });
                }
                if (request.actionId === 'remote_hosts.setup_as_machine') {
                    if (!resolveSetupSurfacePolicy().machine.allowRemoteSshMachineSetup
                        || runner.mode === 'native' && getFeatureBuildPolicyDecision('setup.ssh.nativeTransport') === 'deny') {
                        throw new RemoteHostOperationError('machine_setup_unavailable');
                    }
                    return startRemoteHostSetupTask({ ...admission, scope, host, expectedRevision: request.input.expectedRevision,
                        remoteHostId: host.id, homeTarget: await account.resolveHomeTarget(), shareableServerUrl: account.shareableServerUrl });
                }
                const action = Object.entries(REMOTE_HOST_MAINTENANCE_ACTION_IDS).find(([, id]) => id === request.actionId)?.[0];
                if (!action) throw new RemoteHostOperationError('unsupported_action');
                return startRemoteHostMaintenanceTask({ ...admission, action: action as RemoteHostMaintenanceTaskAction });
            }, context.signal) };
        } catch (error) {
            if (!(error instanceof RemoteHostOperationError)) throw error;
            return { ok: true, result: error.revision === undefined ? { status: 'unavailable', reason: error.reason }
                : { status: 'conflict', revision: error.revision } };
        }
    };
}
