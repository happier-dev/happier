import type {
    PluginReviewsServiceV1,
    PluginStorageScopeServiceV1,
} from '../context.js';
import type {
    ExecLaunchInputV1,
    ExecProcessHandleV1,
    ExecRunOptionsV1,
    ExecRunResultV1,
    ExecRuntimeServiceV1,
    ExecSystemToolServiceV1,
    SystemToolLaunchGrantV1,
} from '../exec.js';
import type {
    FetchRuntimeRequestV1,
    FetchRuntimeResponseV1,
    FetchRuntimeServiceV1,
} from '../fetch.js';
import type { LocalServicesRuntimeServiceV1, LocalServiceRuntimeSnapshotV1 } from '../localServices.js';
import type { ManagedServerHandleV1, ManagedServerRuntimeServiceV1, ManagedServerSpecV1 } from '../managedServer.js';
import type { McpRuntimeServiceV1 } from '../mcp.js';
import type { ProgressHandleV1, ProgressRuntimeServiceV1, ProgressSnapshotV1 } from '../progress.js';
import type { PluginActionsServiceV1 } from '../generated/actions.js';
import type { PluginContextFixtureRecordsV1 } from './contextFixtureTypes.js';

export function failNotConfigured(operation: string): never {
    throw new Error(`PluginContextV1 fixture service is not configured for ${operation}`);
}

export async function notConfigured<T>(operation: string): Promise<T> {
    return failNotConfigured(operation);
}

export function createDefaultFetch(records: PluginContextFixtureRecordsV1): FetchRuntimeServiceV1 {
    return async (request: FetchRuntimeRequestV1) => {
        records.fetchRequests.push(request);
        return {
            ok: false,
            status: 501,
            statusText: 'Not Implemented',
            headers: {},
            body: null,
            text: async () => '',
            json: async () => null,
            arrayBuffer: async () => new ArrayBuffer(0),
        } satisfies FetchRuntimeResponseV1;
    };
}

export function createStorageScope(): PluginStorageScopeServiceV1 {
    const values = new Map<string, unknown>();
    return {
        async get<T = unknown>(key: string): Promise<T | null> {
            return values.has(key) ? (values.get(key) as T) ?? null : null;
        },
        async set(key, value) {
            values.set(key, value);
        },
        async delete(key) {
            values.delete(key);
        },
        async listKeys() {
            return [...values.keys()];
        },
    };
}

function createUnavailableProcessHandle(): ExecProcessHandleV1 {
    return {
        pid: null,
        exit: Promise.resolve({ exitCode: null, signal: null, stdout: '', stderr: '' }),
        async writeStdin() {
            failNotConfigured('exec.process.writeStdin');
        },
        kill() {
            return undefined;
        },
        async dispose() {
            return undefined;
        },
    };
}

export function createExecService(): ExecRuntimeServiceV1 {
    const systemTools: ExecSystemToolServiceV1 = {
        async resolve(request): Promise<SystemToolLaunchGrantV1> {
            return {
                grantId: `fixture:${request.toolId}`,
                toolId: request.toolId,
                displayName: request.toolId,
                source: 'system',
                executablePath: request.preferredPath ?? request.preferredCommand ?? request.toolId,
                launch: {
                    kind: 'binary',
                    executablePath: request.preferredPath ?? request.preferredCommand ?? request.toolId,
                    args: [],
                    cwd: request.cwd,
                },
            };
        },
    };
    const spawnClient = (() => notConfigured('exec.spawnClient')) as ExecRuntimeServiceV1['spawnClient'];
    return {
        systemTools,
        async run(_input: ExecLaunchInputV1, _options?: ExecRunOptionsV1): Promise<ExecRunResultV1> {
            return { exitCode: 0, signal: null, stdout: '', stderr: '' };
        },
        async spawn() {
            return createUnavailableProcessHandle();
        },
        spawnClient,
    };
}

function createManagedServerHandle(spec: ManagedServerSpecV1): ManagedServerHandleV1 {
    const snapshot = {
        id: spec.id,
        state: 'healthy',
        pid: null,
        startedAt: Date.now(),
        lastHealthyAt: Date.now(),
        lastErrorMessage: null,
    } satisfies ReturnType<ManagedServerHandleV1['snapshot']>;
    return {
        snapshot: () => snapshot,
        async waitUntilHealthy() {
            return snapshot;
        },
        async dispose() {
            return undefined;
        },
    };
}

export function createManagedServerService(): ManagedServerRuntimeServiceV1 {
    return {
        async supervise(spec) {
            return createManagedServerHandle(spec);
        },
    };
}

export function createLocalServices(): LocalServicesRuntimeServiceV1 {
    const declarations = new Set<string>();
    const snapshotFor = (id: string): LocalServiceRuntimeSnapshotV1 => ({
        id,
        phase: declarations.has(id) ? 'running' : 'stopped',
        diagnostics: [],
    });
    return {
        async declare(declaration) {
            declarations.add(declaration.id);
        },
        async start(id) {
            declarations.add(id);
            return {
                snapshot: () => snapshotFor(id),
                async stop() {
                    declarations.delete(id);
                },
            };
        },
        async get(id) {
            return declarations.has(id) ? snapshotFor(id) : null;
        },
    };
}

export function createMcpService(): McpRuntimeServiceV1 {
    return {
        async startServer(spec) {
            return {
                id: spec.id,
                spec,
                async dispose() {
                    return undefined;
                },
            };
        },
        async createClient(spec) {
            return {
                id: spec.id,
                spec,
                async dispose() {
                    return undefined;
                },
            };
        },
        async list() {
            return [];
        },
        async resolveForSession() {
            return [];
        },
    };
}

function createProgressHandle(id: string, label: string, total: number | null): ProgressHandleV1 {
    let current: number | null = null;
    let state: ProgressSnapshotV1['state'] = 'active';
    let message: string | null = null;
    const snapshot = (): ProgressSnapshotV1 => ({ id, label, state, current, total, message });
    return {
        id,
        report(update) {
            if ('current' in update) current = update.current ?? null;
            if ('total' in update) total = update.total ?? null;
            if ('message' in update) message = update.message ?? null;
        },
        finish(nextMessage) {
            state = 'finished';
            message = nextMessage ?? message;
        },
        fail(error) {
            state = 'failed';
            message = error instanceof Error ? error.message : String(error);
        },
        snapshot,
    };
}

export function createProgressService(): ProgressRuntimeServiceV1 {
    const handles = new Map<string, ProgressHandleV1>();
    return {
        start(params) {
            const id = params.id ?? `progress-${handles.size + 1}`;
            const handle = createProgressHandle(id, params.label, params.total ?? null);
            handles.set(id, handle);
            return handle;
        },
        report(id, update) {
            handles.get(id)?.report(update);
        },
        finish(id, message) {
            handles.get(id)?.finish(message);
        },
    };
}

export function createReviewsService(): PluginReviewsServiceV1 {
    const comments = {
        create: () => notConfigured('reviews.comments.create'),
        list: () => notConfigured('reviews.comments.list'),
        get: () => notConfigured('reviews.comments.get'),
        transition: () => notConfigured('reviews.comments.transition'),
        edit: () => notConfigured('reviews.comments.edit'),
        reply: () => notConfigured('reviews.comments.reply'),
        bulkTransition: () => notConfigured('reviews.comments.bulkTransition'),
        redact: () => notConfigured('reviews.comments.redact'),
        setDisposition: () => notConfigured('reviews.comments.setDisposition'),
        attachEvidence: () => notConfigured('reviews.comments.attachEvidence'),
        resolveSnapshot: () => notConfigured('reviews.comments.resolveSnapshot'),
    } satisfies PluginReviewsServiceV1['comments'];
    return { comments };
}

export function createActionsService(): PluginActionsServiceV1 {
    return {
        approvals: {
            request: async () => ({ approvalRequestId: 'fixture-approval' }),
            get: async () => null,
            list: () => notConfigured('actions.approvals.list'),
        },
        scm: {
            pullRequest: {
                list: () => notConfigured('actions.scm.pullRequest.list'),
                get: () => notConfigured('actions.scm.pullRequest.get'),
                openOrReuse: () => notConfigured('actions.scm.pullRequest.openOrReuse'),
                openCompose: () => notConfigured('actions.scm.pullRequest.openCompose'),
                checkout: () => notConfigured('actions.scm.pullRequest.checkout'),
                prepareWorktree: () => notConfigured('actions.scm.pullRequest.prepareWorktree'),
                runStacked: () => notConfigured('actions.scm.pullRequest.runStacked'),
            },
            repository: {
                clone: () => notConfigured('actions.scm.repository.clone'),
                init: () => notConfigured('actions.scm.repository.init'),
                removeIndexLock: () => notConfigured('actions.scm.repository.removeIndexLock'),
            },
            hostingRepository: {
                describePublishTargets: () => notConfigured('actions.scm.hostingRepository.describePublishTargets'),
                publish: () => notConfigured('actions.scm.hostingRepository.publish'),
            },
            diffSummary: {
                generate: () => notConfigured('actions.scm.diffSummary.generate'),
            },
        },
    };
}
