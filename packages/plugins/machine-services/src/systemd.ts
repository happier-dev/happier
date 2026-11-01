import { PluginError, type Disposable, type PluginInvocationContext, type PluginProjectNativeAdapterRuntimeV1,
    type PluginCancellationOptions, type PluginProjectNativeFailureV1 } from '@happier-dev/plugin-sdk';
import type { ManagedServiceNativeInstanceV1, ManagedServiceNativeLifecycleV1,
    ManagedServiceNativeObservationV1, ManagedServiceNativeLogReadV1, ManagedServiceNativeLogResultV1,
    ManagedServiceNativeLogWatchV1 } from '@happier-dev/plugin-sdk/managed-services';
import { readJournal } from './journal.js';
import { watchJournal } from './journalWatch.js';

const adapter = { pluginId: 'happier.machine.services', localId: 'systemd' } as const;
type Scope = 'user' | 'system';

function parseInstance(instance: ManagedServiceNativeInstanceV1): Readonly<{ scope: Scope; unit: string }> {
    const match = /^(user|system)\/([a-zA-Z0-9:_.@\\-]+\.service)$/u.exec(instance.nativeResourceId);
    if (instance.adapter.pluginId !== adapter.pluginId || instance.adapter.localId !== adapter.localId || !match) {
        throw new PluginError({ code: 'systemd_invalid_native_resource', message: 'The exact systemd service identity is invalid' });
    }
    return { scope: match[1] as Scope, unit: match[2]! };
}

/** Native liveness is not application readiness. Unknown platform states stay unknown. */
function observation(load: string | undefined, active: string | undefined, sub: string | undefined): ManagedServiceNativeObservationV1 {
    if (load !== 'loaded') return { phase: 'unknown', readiness: 'not_ready', endpoint: null };
    if (active === 'inactive' || active === 'failed') return { phase: 'stopped', readiness: 'not_ready', endpoint: null };
    if (active === 'active' && (sub === 'running' || sub === 'exited')) {
        return { phase: 'running', readiness: 'not_reported', endpoint: null };
    }
    return { phase: 'unknown', readiness: 'not_ready', endpoint: null };
}

async function command(scope: Scope, args: readonly string[], options: PluginCancellationOptions | undefined, context: PluginInvocationContext | undefined) {
    if (!context) throw new PluginError({ code: 'systemd_invocation_unavailable', message: 'Native service invocation is unavailable' });
    const env = Object.fromEntries(['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'].flatMap(key => {
        const value = process.env[key];
        return value === undefined ? [] : [[key, value]];
    }));
    // The public Exec seam retains cancellation, currentness and process custody.
    // No cwd, Agent qualifier, shell or privileged launcher is introduced.
    const result = await context.services.exec.run({ executable: { kind: 'systemTool', id: 'systemctl' },
        args: [...(scope === 'user' ? ['--user'] : []), '--no-ask-password', ...args], env }, options);
    const successful = result.termination.requestedBy.kind === 'none'
        && result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0;
    return { complete: successful && !result.stdoutTruncated, successful,
        truncated: result.stdoutTruncated, output: new TextDecoder().decode(result.stdout) };
}

async function inspect(instance: ManagedServiceNativeInstanceV1, options?: PluginCancellationOptions, context?: PluginInvocationContext) {
    const selected = parseInstance(instance);
    if (process.platform !== 'linux') return observation(undefined, undefined, undefined);
    const result = await command(selected.scope, ['show', '--no-pager', '--property=LoadState,ActiveState,SubState', '--', selected.unit], options, context);
    if (!result.complete) return observation(undefined, undefined, undefined);
    const properties = new Map(result.output.split(/\r?\n/u).flatMap(line => {
        const separator = line.indexOf('=');
        return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1)] as const];
    }));
    return observation(properties.get('LoadState'), properties.get('ActiveState'), properties.get('SubState'));
}

async function control(verb: 'start' | 'restart', instance: ManagedServiceNativeInstanceV1,
    options?: PluginCancellationOptions, context?: PluginInvocationContext): Promise<ManagedServiceNativeObservationV1 | PluginProjectNativeFailureV1> {
    const selected = parseInstance(instance);
    if (process.platform !== 'linux' || selected.scope !== 'user') return { kind: 'unsupported', code: 'systemd_control_unsupported' };
    const result = await command(selected.scope, [verb, '--', selected.unit], options, context);
    if (!result.complete) return { kind: 'failed', code: `systemd_${verb}_unconfirmed` };
    return await inspect(instance, options, context);
}

function nativeLogs(instance: ManagedServiceNativeInstanceV1, request: ManagedServiceNativeLogReadV1,
    context?: PluginInvocationContext): Promise<ManagedServiceNativeLogResultV1>;
function nativeLogs(instance: ManagedServiceNativeInstanceV1, request: ManagedServiceNativeLogWatchV1,
    context?: PluginInvocationContext): Promise<Disposable>;
async function nativeLogs(instance: ManagedServiceNativeInstanceV1,
    request: ManagedServiceNativeLogReadV1 | ManagedServiceNativeLogWatchV1,
    context?: PluginInvocationContext): Promise<ManagedServiceNativeLogResultV1 | Disposable> {
    const selected = parseInstance(instance);
    if (request.kind === 'read') return await readJournal(selected, request, context);
    return await watchJournal(selected, request, context);
}

const lifecycle: ManagedServiceNativeLifecycleV1 = {
    logs: nativeLogs,
    async discover(_machine, options, context) {
        if (process.platform !== 'linux') return { kind: 'unsupported', code: 'systemd_platform_unsupported' };
        const candidates: Array<{ instance: ManagedServiceNativeInstanceV1; name: string; observation: ManagedServiceNativeObservationV1 }> = [];
        const failures: PluginProjectNativeFailureV1[] = [];
        // One finite query per native manager, only on explicit discovery demand.
        for (const scope of ['user', 'system'] as const) {
            const result = await command(scope, ['list-units', '--type=service', '--all', '--plain', '--no-legend', '--no-pager'], options, context);
            if (!result.successful) { failures.push({ kind: 'unavailable', code: `systemd_${scope}_discovery_unavailable` }); continue; }
            const lines = result.output.split(/\r?\n/u);
            if (result.truncated) {
                failures.push({ kind: 'unavailable', code: `systemd_${scope}_discovery_truncated` });
                // The captured suffix may only resemble a row. Retain records
                // solely when the native newline was observed before the cap.
                lines.pop();
            }
            for (const line of lines) {
                const fields = line.trim().split(/\s+/u);
                const unit = fields[0];
                if (!unit || !/^[a-zA-Z0-9:_.@\\-]+\.service$/u.test(unit) || fields.length < 4) continue;
                candidates.push({ instance: { adapter, nativeResourceId: `${scope}/${unit}` }, name: unit,
                    observation: observation(fields[1], fields[2], fields[3]) });
            }
        }
        return { kind: failures.length ? 'partial' : 'ready', candidates, failures };
    },
    inspect,
    start: (instance, options, context) => control('start', instance, options, context),
    restart: (instance, options, context) => control('restart', instance, options, context),
    async stop(instance, options, context) {
        const selected = parseInstance(instance);
        // System mutation requires the actual host P10 authority, not a sudo/polkit fallback.
        if (process.platform !== 'linux' || selected.scope !== 'user') return { status: 'unsupported' };
        const result = await command(selected.scope, ['stop', '--', selected.unit], options, context);
        if (!result.complete) return { status: 'termination_incomplete' };
        const current = await inspect(instance, options, context);
        return { status: current.phase === 'stopped' ? 'stopped' : 'termination_incomplete' };
    },
};

export const systemdRuntime: PluginProjectNativeAdapterRuntimeV1 = { nativeServiceLifecycle: lifecycle };
