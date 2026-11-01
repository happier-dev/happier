import type { MachineRecipeStepV1, MachineSetupApplyResultV1 } from './index.js';
import type { MachineSetupNativeCommand, MachineSetupNativeCommandResult } from './nativeBackend.js';
import { compareVersions } from '../update/compareVersions.js';

/** Actor-selected private Domain config, never a host-selected image default. */
export type NativeCloudflareConnectorSelection = Readonly<{ imageRef: string; version: string }>;
export type NativeCloudflareConnectorInput = Readonly<{
    tunnelId: string; connector: NativeCloudflareConnectorSelection;
    /** P41's captured container origin supplies this exact network. */
    networkName: string; grantRef: string;
}>;
export type NativeCloudflareConnectorObservation =
    | Readonly<{ status: 'ready' | 'stopped'; containerId: string }>
    | Readonly<{ status: 'needs_setup' }>
    | Readonly<{ status: 'unavailable'; reason: 'required_fact_unavailable' | 'foreign_effect_conflict' | 'native_effect_failed' }>;
export type NativeCloudflareConnectorResult = NativeCloudflareConnectorObservation
    | Readonly<{ status: 'outcome_unknown'; reason: 'native_effect_failed' }>;
export type NativeCloudflareConnectorRemovalResult =
    | Readonly<{ status: 'removed' }>
    | Extract<NativeCloudflareConnectorObservation, { status: 'unavailable' }>
    | Readonly<{ status: 'outcome_unknown'; reason: 'native_effect_failed' }>;
type ContainerInput = Omit<NativeCloudflareConnectorInput, 'grantRef'>;
type NativeOptions = Readonly<{
    /** The containing P30 admission supplies its already-selected Docker transport. */
    run(command: MachineSetupNativeCommand): Promise<MachineSetupNativeCommandResult>;
    signal?: AbortSignal;
}>;
const ownerLabel = 'dev.happier.machine-setup.recipe';
const ownerValue = 'cloudflare-connector@1';
const tokenStepId = 'cloudflare-connector-token';
// The vendor's documented first metrics port, fixed only inside this private
// connector namespace. No host publish, host listener, allocator or poller.
const metricsAddress = '127.0.0.1:20241';
const unavailable = (reason: Extract<NativeCloudflareConnectorObservation, { status: 'unavailable' }>['reason']) =>
    ({ status: 'unavailable' as const, reason });
function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> | undefined { return isObject(value) ? value : undefined; }
function tokenPath(tunnelId: string): string {
    return `/etc/cloudflared/happier-${encodeURIComponent(tunnelId)}.token`;
}
function containerName(tunnelId: string): string { return `happier-cloudflared-${tunnelId}`; }
function command(input: ContainerInput): string[] {
    // The empty CLI token overrides image env/config token defaults. The
    // vendor then reads token-file; no credential bytes occur in arguments.
    return ['tunnel', '--no-autoupdate', '--metrics', metricsAddress, 'run', '--token=', '--token-file', tokenPath(input.tunnelId)];
}
function supportedVersion(version: string): boolean {
    // compareVersions has a lexical fallback for other consumers. Admit this
    // native numeric release spelling before asking it for the ordered floor.
    return /^\d+\.\d+\.\d+$/.test(version) && compareVersions(version, '2025.4.0') >= 0;
}
function runDocker(options: NativeOptions, args: readonly string[]) {
    options.signal?.throwIfAborted();
    return options.run({ executable: 'docker', args, ...(options.signal ? { signal: options.signal } : {}) });
}
/** P20 alone opens the grant and applies its normal protected-file writer. */
export function createCloudflareConnectorSetupSteps(input: Pick<NativeCloudflareConnectorInput, 'tunnelId' | 'grantRef'>): MachineRecipeStepV1[] {
    return [
        { id: 'cloudflare-connector-directory', kind: 'directory', path: '/etc/cloudflared', owner: 'root', group: 'root',
            mode: 0o755, protectedAncestors: true },
        { id: tokenStepId, kind: 'file', path: tokenPath(input.tunnelId), owner: 'root', group: 'root', mode: 0o600,
            content: { kind: 'secretGrant', grantRef: input.grantRef } },
    ];
}
/** The reviewed parent selected this exact connector for retirement. P20
 * opens the expected bytes privately and removes only an exact protected-file
 * match; the consumer neither hashes nor unlinks the token. Keep the shared
 * /etc/cloudflared directory and every other connector's file intact. */
export function createCloudflareConnectorRemovalSteps(input: Pick<NativeCloudflareConnectorInput, 'tunnelId' | 'grantRef'>): MachineRecipeStepV1[] {
    return [{ id: tokenStepId, kind: 'file', state: 'absent', path: tokenPath(input.tunnelId),
        owner: 'root', group: 'root', mode: 0o600,
        content: { kind: 'secretGrant', grantRef: input.grantRef } }];
}
type OwnedContainer = Readonly<{ status: 'observed'; containerId: string; running: boolean }>;
async function inspect(input: ContainerInput, options: NativeOptions): Promise<OwnedContainer
    | Exclude<NativeCloudflareConnectorObservation, { status: 'ready' | 'stopped' }>> {
    const name = containerName(input.tunnelId);
    const listed = await runDocker(options, ['container', 'ls', '--all', '--no-trunc', '--filter',
        `name=^/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, '--format', '{{json .ID}}']);
    if (listed.code !== 0) return unavailable('required_fact_unavailable');
    let ids: unknown[];
    try { ids = listed.stdout.trim() ? listed.stdout.trim().split('\n').map(line => JSON.parse(line)) : []; }
    catch { return unavailable('required_fact_unavailable'); }
    if (ids.length !== 1) return ids.length === 0 ? { status: 'needs_setup' } : unavailable('required_fact_unavailable');
    if (typeof ids[0] !== 'string' || !ids[0]) return unavailable('required_fact_unavailable');
    const result = await runDocker(options, ['container', 'inspect', '--', ids[0]]);
    if (result.code !== 0) return unavailable('required_fact_unavailable');
    let raw: unknown;
    try { raw = JSON.parse(result.stdout); } catch { return unavailable('required_fact_unavailable'); }
    const row = Array.isArray(raw) && raw.length === 1 ? object(raw[0]) : undefined;
    const config = object(row?.Config), host = object(row?.HostConfig), state = object(row?.State);
    const networks = object(object(row?.NetworkSettings)?.Networks);
    if (!row || row.Id !== ids[0] || typeof state?.Running !== 'boolean' || !config || !host || !networks) {
        return unavailable('required_fact_unavailable');
    }
    const mounts = Array.isArray(host.Mounts) ? host.Mounts : [];
    const mount = mounts.length === 1 ? object(mounts[0]) : undefined;
    const ports = host.PortBindings === null ? {} : object(host.PortBindings);
    const capAdd = host.CapAdd === null ? [] : host.CapAdd;
    if (row.Name !== `/${name}` || object(config.Labels)?.[ownerLabel] !== ownerValue
        || config.Image !== input.connector.imageRef || config.User !== '0:0'
        || JSON.stringify(config.Entrypoint) !== JSON.stringify(['cloudflared'])
        || JSON.stringify(config.Cmd) !== JSON.stringify(command(input))
        || object(host.RestartPolicy)?.Name !== 'unless-stopped' || host.NetworkMode !== input.networkName
        || Object.keys(networks).length !== 1 || !Object.hasOwn(networks, input.networkName)
        || host.Privileged !== false || host.ReadonlyRootfs !== true || host.PublishAllPorts !== false
        || !ports || Object.keys(ports).length !== 0 || Array.isArray(host.Binds) && host.Binds.length > 0
        || !Array.isArray(capAdd) || capAdd.length !== 0
        || !Array.isArray(host.CapDrop) || !host.CapDrop.includes('ALL')
        || !Array.isArray(host.SecurityOpt) || !host.SecurityOpt.includes('no-new-privileges')
        || mount?.Type !== 'bind' || mount.Source !== tokenPath(input.tunnelId)
        || mount.Target !== tokenPath(input.tunnelId) || mount.ReadOnly !== true) return unavailable('foreign_effect_conflict');
    return { status: 'observed', containerId: ids[0], running: state.Running };
}
async function observe(input: NativeCloudflareConnectorInput,
    options: NativeOptions): Promise<NativeCloudflareConnectorObservation> {
    options.signal?.throwIfAborted();
    try {
        const container = await inspect(input, options);
        if (container.status !== 'observed') return container;
        if (!container.running) return { status: 'stopped', containerId: container.containerId };
        const version = await runDocker(options, ['exec', '--user', '0:0', container.containerId, 'cloudflared', '--version']);
        const observed = /^cloudflared version (\d+\.\d+\.\d+)(?:[ \t].*)?\r?\n?$/.exec(version.stdout)?.[1];
        if (version.code !== 0 || observed !== input.connector.version) return unavailable('required_fact_unavailable');
        const ready = await runDocker(options, ['exec', '--user', '0:0', container.containerId,
            'cloudflared', 'tunnel', '--metrics', metricsAddress, 'ready']);
        if (ready.code !== 0) return unavailable('native_effect_failed');
        return { status: 'ready', containerId: container.containerId };
    } catch {
        options.signal?.throwIfAborted();
        return unavailable('required_fact_unavailable');
    }
}
/** Config.User is reviewed intent, not a rootless/userns access proof. The
 * fixed entrypoint and empty-token override make native readiness depend on
 * token-file startup; the real unreadable-mount counterexample is required. */
export async function observeNativeCloudflareConnector(input: NativeCloudflareConnectorInput,
    options: NativeOptions): Promise<NativeCloudflareConnectorObservation> {
    if (!supportedVersion(input.connector.version)) return unavailable('required_fact_unavailable');
    return observe(input, options);
}
/** Same admitted native operation, after the real P20 file result. No service
 * process belongs to Happier's daemon lifetime, and no local retry is added.
 * An image change requires explicit reviewed retirement using the OLD captured
 * selection, then recreation with the NEW one; config mismatch never authorizes
 * deleting a container. Actual version/readiness failure after start stays an
 * honest partial outcome rather than pretending the root file was not written. */
export async function ensureNativeCloudflareConnector(input: NativeCloudflareConnectorInput,
    options: NativeOptions & Readonly<{ setupResult: MachineSetupApplyResultV1 }>): Promise<NativeCloudflareConnectorResult> {
    options.signal?.throwIfAborted();
    if (options.setupResult.status !== 'applied') return { status: 'needs_setup' };
    if (!supportedVersion(input.connector.version)) return unavailable('required_fact_unavailable');
    let issued = false;
    try {
        const container = await inspect(input, options);
        if (container.status === 'unavailable') return container;
        let id: string;
        if (container.status === 'needs_setup') {
            issued = true;
            const created = await runDocker(options, ['container', 'create', '--name', containerName(input.tunnelId),
                '--label', `${ownerLabel}=${ownerValue}`, '--restart', 'unless-stopped', '--user', '0:0',
                '--network', input.networkName, '--entrypoint', 'cloudflared', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--mount', `type=bind,src=${tokenPath(input.tunnelId)},dst=${tokenPath(input.tunnelId)},readonly`,
                '--', input.connector.imageRef, ...command(input)]);
            id = created.stdout.trim();
            if (created.code !== 0 || !id) return { status: 'outcome_unknown', reason: 'native_effect_failed' };
            const started = await runDocker(options, ['container', 'start', '--', id]);
            if (started.code !== 0) return { status: 'outcome_unknown', reason: 'native_effect_failed' };
        } else {
            id = container.containerId;
            if (!container.running || options.setupResult.completedStepIds.includes(tokenStepId)) {
                issued = true;
                // P20's atomic file replacement creates a new inode. Restart
                // re-establishes the bind mount at the same exact private path.
                const settled = await runDocker(options, ['container', container.running ? 'restart' : 'start', '--', id]);
                if (settled.code !== 0) return { status: 'outcome_unknown', reason: 'native_effect_failed' };
            }
        }
        const verified = await observe(input, options);
        return verified.status === 'ready' || !issued ? verified : { status: 'outcome_unknown', reason: 'native_effect_failed' };
    } catch {
        options.signal?.throwIfAborted();
        return issued ? { status: 'outcome_unknown', reason: 'native_effect_failed' } : unavailable('required_fact_unavailable');
    }
}
/** Call only after the owning reviewed Domain operation chose retirement.
 * No shared/last-consumer policy is re-decided here. Root file removal follows
 * this settlement through P20's private secretGrant absence operand;
 * never unlink the protected file from this container adapter. */
export async function removeNativeCloudflareConnector(input: ContainerInput,
    options: NativeOptions): Promise<NativeCloudflareConnectorRemovalResult> {
    options.signal?.throwIfAborted();
    let issued = false;
    try {
        const container = await inspect(input, options);
        if (container.status === 'unavailable') return container;
        if (container.status === 'needs_setup') return { status: 'removed' };
        issued = true;
        if (container.running) {
            const stopped = await runDocker(options, ['container', 'stop', '--', container.containerId]);
            if (stopped.code !== 0) return { status: 'outcome_unknown', reason: 'native_effect_failed' };
        }
        const removed = await runDocker(options, ['container', 'rm', '--', container.containerId]);
        return removed.code === 0 ? { status: 'removed' } : { status: 'outcome_unknown', reason: 'native_effect_failed' };
    } catch {
        options.signal?.throwIfAborted();
        return issued ? { status: 'outcome_unknown', reason: 'native_effect_failed' } : unavailable('required_fact_unavailable');
    }
}
