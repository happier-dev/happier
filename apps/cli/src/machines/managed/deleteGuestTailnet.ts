import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh/shellQuote';
import { tailscaleLogoutCommand } from '@happier-dev/cli-common/relayAccess/providers/tailscale/membership';
import { parseTailscaleStatusJson } from '@happier-dev/cli-common/tailscale';
import { createManagedNativeBootstrapIO, ManagedMachineControllerError, projectManagedDeleteTailnetWarning } from '@happier-dev/cli-common/machines/managed';
import type { ManagedNativeInvocationIO } from '@happier-dev/cli-common/machines/managed/reconcile';
import { buildDedicatedDaemonInvocationCommand } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { ManagedBootstrapCarrierV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { ManagedDeleteTailnetWarningV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';
import { prepareManagedSessionSshTrust } from './enrollmentSshTrust';
import { createManagedSshSessionTransport } from './sessionSshTransport';
import type { createManagedNativeInvocation } from './reconcile';

/** Last observed native node, available only through the caller's existing Machine content authority. */
export async function readManagedDeleteTailnetWarning(machineId: string, host: Readonly<{
    credentials: StoredCredentials; serverUrl: string; context?: ActionExecutorContext; signal?: AbortSignal;
}>): Promise<ManagedDeleteTailnetWarningV1 | undefined> {
    try {
        const { ApiClient } = await import('@/api/api');
        const authorization = host.context?.externalActionExecutionAuthorization;
        const guest = await runWithServerHttpBaseUrl(host.serverUrl, async () => authorization
            ? ApiClient.getRequesterMachine(machineId, { signal: host.signal, authorization })
            : (await ApiClient.create(host.credentials)).getMachine(machineId, { signal: host.signal }));
        return projectManagedDeleteTailnetWarning(guest?.daemonState);
    } catch {
        if (host.signal?.aborted) throw new ManagedMachineControllerError('cancelled');
    }
}

/** Runs on the exact enrolled guest under the controller's already-admitted Delete. */
export async function logoutManagedDeleteGuest(machine: ManagedMachineFullV1,
    native: ReturnType<typeof createManagedNativeInvocation>, invokeGuestRole: Parameters<NonNullable<ManagedNativeInvocationIO['beforeDestroy']>>[0],
    host: Parameters<typeof readManagedDeleteTailnetWarning>[1],
): Promise<ManagedDeleteTailnetWarningV1 | undefined> {
    if (!machine.enrolledMachineId || !machine.resource) return;
    const { enrolledMachineId, resource } = machine;
    const { signal } = host;
    const wrapCommand = machine.enrollmentIdentity?.kind === 'dedicatedDaemonUser' ? buildDedicatedDaemonInvocationCommand : undefined;
    let node: string | null = null;
    let cleanup: (() => Promise<void>) | undefined;
    try {
        let io: ReturnType<typeof createManagedNativeBootstrapIO> | undefined;
        if (native.contribution.definition.bootstrapTransport) {
            io = createManagedNativeBootstrapIO({ resource }, (role, body, options) => {
                if (role !== 'exec') throw new ManagedMachineControllerError('native_intent_unsupported');
                return invokeGuestRole(role, body, options);
            }, wrapCommand);
        } else if (machine.bootstrapCredentialRef) {
            const carrier = ManagedBootstrapCarrierV1Schema.parse(await invokeGuestRole('bootstrap', await native.readBootstrapInput(), { signal }));
            if (carrier.kind === 'ssh') {
                const credential = await native.materializeBootstrapCredential(carrier.credentialRef);
                cleanup = credential.dispose;
                const trust = await prepareManagedSessionSshTrust({ correlation: machine, carrier,
                    guestHostPublicKey: credential.guestHostPublicKey });
                io = createManagedSshSessionTransport({ carrier, credentialPath: credential.path, knownHostsPath: trust.knownHostsPath,
                    lifetime: signal ?? new AbortController().signal, wrapCommand }).io;
            }
        }
        if (io) {
            const { exec } = io;
            const run = (args: readonly string[]) => exec({
                command: [tailscaleLogoutCommand.executable, ...args].map(safeBashSingleQuote).join(' '), signal, allowWake: false,
            });
            const status = await run(['status', '--json']);
            if (status.status === 0) {
                const membership = parseTailscaleStatusJson(status.stdout);
                if (membership.backendState === 'NeedsLogin') return;
                if (membership.loggedIn) {
                    node = membership.dnsName;
                    if ((await run(tailscaleLogoutCommand.args)).status === 0) return;
                }
            }
        }
    } catch {
        if (signal?.aborted) throw new ManagedMachineControllerError('cancelled');
    } finally {
        try { await cleanup?.(); }
        catch { logger.warn('[MANAGED MACHINE] SSH credential cleanup failed'); }
    }
    return node ? { code: 'tailscale_logout_unconfirmed', node } : readManagedDeleteTailnetWarning(enrolledMachineId, host);
}
