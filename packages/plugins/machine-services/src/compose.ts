import { isPluginError, type Disposable, type PluginCancellationOptions, type PluginInvocationContext,
    type PluginProjectNativeAdapterRuntimeV1, type PluginProjectNativeFailureV1 } from '@happier-dev/plugin-sdk';
import type { ManagedServiceNativeInstanceV1, ManagedServiceNativeLifecycleV1, ManagedServiceNativeObservationV1,
    ManagedServiceNativeLogReadV1, ManagedServiceNativeLogWatchV1,
    ManagedServiceNativeLogResultV1 } from '@happier-dev/plugin-sdk/managed-services';

const adapter = { pluginId: 'happier.machine.services', localId: 'compose' } as const;
const docker = { kind: 'systemTool', id: 'docker' } as const;
type Selection = Readonly<{ engineId: string; project: string; service?: string }>;
type Container = Readonly<{ id: string; project: string; service: string; state: string; health?: string }>;
const unknown: ManagedServiceNativeObservationV1 = { phase: 'unknown', readiness: 'not_reported', endpoint: null };

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Same native tuple used by deployment/workspace observation custody. */
function selection(instance: ManagedServiceNativeInstanceV1): Selection | null {
    if (instance.adapter.pluginId !== adapter.pluginId || instance.adapter.localId !== adapter.localId) return null;
    try {
        const value: unknown = JSON.parse(instance.nativeResourceId);
        if (!Array.isArray(value) || value.length !== 2 && value.length !== 3
            || value.some(part => typeof part !== 'string' || !part || part.includes('\0'))) return null;
        return { engineId: value[0], project: value[1], ...(value.length === 3 ? { service: value[2] } : {}) };
    } catch { return null; }
}

function failure(error: unknown, options?: PluginCancellationOptions): PluginProjectNativeFailureV1 {
    if (isPluginError(error) && error.code === 'plugin_exec_termination_incomplete') throw error;
    if (options?.signal?.aborted) return { kind: 'cancelled', code: 'native_adapter_cancelled' };
    return { kind: 'unavailable', code: isPluginError(error) ? error.code : 'compose_native_unavailable' };
}

async function command(args: readonly string[], context: PluginInvocationContext, options?: PluginCancellationOptions,
    maxBytes?: number) {
    const result = await context.services.exec.run({ executable: docker, args,
        ...(maxBytes === undefined ? {} : { maxStdoutBytes: maxBytes, maxStderrBytes: maxBytes }),
    }, options);
    options?.signal?.throwIfAborted();
    const successful = result.termination.requestedBy.kind === 'none'
        && result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0;
    return { successful, complete: successful && !result.stdoutTruncated,
        stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr),
        truncated: result.stdoutTruncated || result.stderrTruncated };
}

async function engine(context: PluginInvocationContext, options?: PluginCancellationOptions): Promise<string | null> {
    const result = await command(['info', '--format', '{{json .}}'], context, options);
    if (!result.complete) return null;
    try {
        const value: unknown = JSON.parse(result.stdout);
        return record(value) && typeof value.ID === 'string' && value.ID.trim() ? value.ID.trim() : null;
    } catch { return null; }
}

async function containers(context: PluginInvocationContext, options?: PluginCancellationOptions,
    project?: string): Promise<readonly Container[] | null> {
    const listed = await command(['ps', '--all', '--no-trunc', '--filter',
        `label=com.docker.compose.project${project === undefined ? '' : `=${project}`}`,
        '--filter', 'label=com.docker.compose.oneoff=False', '--format', '{{.ID}}'], context, options);
    if (!listed.complete) return null;
    const ids = listed.stdout.trim() ? listed.stdout.trim().split(/\r?\n/u) : [];
    const selectedIds = new Set(ids);
    if (ids.some(id => !/^[a-f0-9]{64}$/u.test(id)) || selectedIds.size !== ids.length) return null;
    if (!ids.length) return [];
    const inspected = await command(['inspect', '--type', 'container', ...ids], context, options);
    if (!inspected.complete) return null;
    try {
        const value: unknown = JSON.parse(inspected.stdout);
        if (!Array.isArray(value) || value.length !== ids.length) return null;
        const rows: Container[] = [];
        for (const item of value) {
            if (!record(item) || typeof item.Id !== 'string' || !selectedIds.has(item.Id)
                || !record(item.Config) || !record(item.Config.Labels) || !record(item.State)
                || typeof item.Config.Labels['com.docker.compose.project'] !== 'string'
                || !item.Config.Labels['com.docker.compose.project']
                || project !== undefined && item.Config.Labels['com.docker.compose.project'] !== project
                || typeof item.Config.Labels['com.docker.compose.service'] !== 'string'
                || !item.Config.Labels['com.docker.compose.service'] || typeof item.State.Status !== 'string'
                || item.State.Health !== undefined && (!record(item.State.Health) || typeof item.State.Health.Status !== 'string')) return null;
            rows.push({ id: item.Id, project: item.Config.Labels['com.docker.compose.project'],
                service: item.Config.Labels['com.docker.compose.service'], state: item.State.Status,
                ...(record(item.State.Health) && typeof item.State.Health.Status === 'string' ? { health: item.State.Health.Status } : {}) });
        }
        return new Set(rows.map(row => row.id)).size === ids.length ? rows : null;
    } catch { return null; }
}

function observation(rows: readonly Container[]): ManagedServiceNativeObservationV1 {
    if (!rows.length) return unknown;
    if (rows.every(row => ['created', 'exited', 'dead'].includes(row.state))) {
        return { phase: 'stopped', readiness: 'not_reported', endpoint: null };
    }
    if (rows.some(row => row.state !== 'running')) return unknown;
    return { phase: 'running', readiness: rows.every(row => row.health === 'healthy') ? 'ready'
        : rows.some(row => row.health === 'unhealthy' || row.health === 'starting') ? 'not_ready' : 'not_reported', endpoint: null };
}

async function current(instance: ManagedServiceNativeInstanceV1, context: PluginInvocationContext,
    options?: PluginCancellationOptions): Promise<readonly Container[] | null> {
    const selected = selection(instance);
    if (!selected || await engine(context, options) !== selected.engineId) return null;
    const rows = await containers(context, options, selected.project);
    return rows && selected.service ? rows.filter(row => row.service === selected.service) : rows;
}

function logs(instance: ManagedServiceNativeInstanceV1, request: ManagedServiceNativeLogReadV1,
    context?: PluginInvocationContext): Promise<ManagedServiceNativeLogResultV1>;
function logs(instance: ManagedServiceNativeInstanceV1, request: ManagedServiceNativeLogWatchV1,
    context?: PluginInvocationContext): Promise<Disposable>;
async function logs(instance: ManagedServiceNativeInstanceV1, request: ManagedServiceNativeLogReadV1 | ManagedServiceNativeLogWatchV1,
    context?: PluginInvocationContext): Promise<ManagedServiceNativeLogResultV1 | Disposable> {
    if (request.kind === 'watch') {
        request.emit({ kind: 'unavailable', reason: 'unsupported' });
        return { dispose() {} };
    }
    if (!context) return { kind: 'unavailable', reason: 'admission_unavailable' };
    try {
        const rows = await current(instance, context, request);
        if (!rows?.length) return { kind: 'unavailable', reason: 'unavailable' };
        const sourceRevision = JSON.stringify(rows.map(row => row.id).sort());
        if (request.cursor && request.cursor.sourceRevision !== sourceRevision) return { kind: 'source-changed', sourceRevision };
        const parts: string[] = [];
        let truncated = false;
        for (const row of rows) {
            // Match the native codec's on-demand diagnostic window. The host's
            // byte budget also bounds the genuine Exec output at its owner.
            const result = await command(['logs', '--tail', String(request.maxBytes), row.id], context, request, request.maxBytes);
            if (!result.successful) return { kind: 'unavailable', reason: 'unavailable' };
            parts.push(result.stdout + result.stderr);
            truncated ||= result.truncated;
        }
        const bytes = new TextEncoder().encode(parts.join('\n'));
        return { kind: 'page', page: { sourceRevision,
            text: new TextDecoder('utf-8').decode(bytes.subarray(0, request.maxBytes), { stream: true }),
            nextCursor: null, truncated: truncated || bytes.byteLength > request.maxBytes } };
    } catch (error) {
        failure(error, request);
        return { kind: 'unavailable', reason: request.signal?.aborted ? 'cancelled' : 'unavailable' };
    }
}

const lifecycle: ManagedServiceNativeLifecycleV1 = {
    logs,
    async discover(_machine, options, context) {
        if (!context) return { kind: 'unavailable', code: 'native_adapter_invocation_unavailable' };
        try {
            const engineId = await engine(context, options);
            if (!engineId) return { kind: 'unavailable', code: 'compose_engine_unavailable' };
            const rows = await containers(context, options);
            if (!rows) return { kind: 'unavailable', code: 'compose_discovery_unavailable' };
            const projects = new Map<string, Container[]>();
            for (const row of rows) {
                const group = projects.get(row.project) ?? [];
                group.push(row); projects.set(row.project, group);
            }
            return { kind: 'ready', candidates: [...projects].map(([project, members]) => ({
                instance: { adapter, nativeResourceId: JSON.stringify([engineId, project]) },
                name: project, observation: observation(members),
            })), failures: [] };
        } catch (error) { return failure(error, options); }
    },
    async inspect(instance, options, context) {
        if (!context) return unknown;
        try { const rows = await current(instance, context, options); return rows ? observation(rows) : unknown; }
        catch (error) { failure(error, options); options?.signal?.throwIfAborted(); return unknown; }
    },
    // Mutation stays unavailable until the host supplies the same project key
    // and native settlement custody used by deployment admission.
    async stop() { return { status: 'unsupported' }; },
};

export const composeRuntime: PluginProjectNativeAdapterRuntimeV1 = { nativeServiceLifecycle: lifecycle };
