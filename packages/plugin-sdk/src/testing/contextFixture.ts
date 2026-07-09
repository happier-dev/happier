import type {
    ArtifactSinkServiceV1,
    ConfigSnapshotServiceV1,
    ConnectionRuntimeServiceV1,
    LoggerServiceV1,
    PluginContextV1,
    PluginEventsServiceV1,
    PluginPermissionsServiceV1,
    ProjectsChangeListenerV1,
    TelemetryServiceV1,
} from '../context.js';
import type { EnvRuntimeServiceV1 } from '../env.js';
import type { ErrorRuntimeServiceV1 } from '../errors.js';
import type { FsRuntimeServiceV1, FsTempDirectoryV1 } from '../fs.js';
import type { RetryRuntimeServiceV1 } from '../retry.js';
import type { SessionHooksRuntimeServiceV1 } from '../sessionHooks.js';
import type { TerminalHostRuntimeServiceV1 } from '../terminalHost.js';
import type { TranscriptsRuntimeServiceV1 } from '../transcripts.js';
import {
    createActionsService,
    createDefaultFetch,
    createExecService,
    createLocalServices,
    createManagedServerService,
    createMcpService,
    createProgressService,
    createReviewsService,
    createStorageScope,
    failNotConfigured,
    notConfigured,
} from './fixtureRuntimeServices.js';
import { createPluginSessionsService, createSessionServices } from './sessionFixture.js';
import { createAccountSettingsService, createAuthService, createSettingsService } from './contextStores.js';
import { createSubscription } from './subscription.js';
import type {
    PluginContextFixtureOptionsV1,
    PluginContextFixtureRecordsV1,
    PluginContextFixtureV1,
} from './contextFixtureTypes.js';

export function createPluginContextV1Fixture(
    options: PluginContextFixtureOptionsV1 = {},
): PluginContextFixtureV1 {
    const records: PluginContextFixtureRecordsV1 = {
        logs: [],
        fetchRequests: [],
        eventEmits: [],
        telemetry: [],
        artifactWrites: [],
        transcriptAppends: [],
        transcriptSourceDefinitions: [],
        sessionSends: [],
        sessionMetadataWrites: [],
        sessionAgentStateWrites: [],
        sessionStateFieldWrites: [],
    };
    const enabledCapabilities = new Set(options.enabledCapabilities ?? []);
    const enabledFeatures = new Set(options.enabledFeatures ?? []);
    const logger: LoggerServiceV1 = {
        debug(message, fields) {
            records.logs.push({ level: 'debug', message, fields });
        },
        info(message, fields) {
            records.logs.push({ level: 'info', message, fields });
        },
        warn(message, fields) {
            records.logs.push({ level: 'warn', message, fields });
        },
        error(message, fields) {
            records.logs.push({ level: 'error', message, fields });
        },
    };
    const config: ConfigSnapshotServiceV1 = {
        values: options.config ?? {},
    };
    const features = {
        isEnabled(featureId: string) {
            return enabledFeatures.has(featureId);
        },
    };
    const permissions: PluginPermissionsServiceV1 = {
        isGranted(id: string) {
            return enabledCapabilities.has(id);
        },
        list() {
            return [...enabledCapabilities];
        },
    };
    const events: PluginEventsServiceV1 = {
        async emit(event) {
            records.eventEmits.push(event);
        },
        subscribe() {
            return createSubscription();
        },
    };
    const telemetry: TelemetryServiceV1 = {
        emit(observation) {
            records.telemetry.push(observation);
        },
    };
    const artifacts: ArtifactSinkServiceV1 = {
        async write(record) {
            records.artifactWrites.push(record);
        },
    };
    const session = createSessionServices(records, options);
    const sessions = createPluginSessionsService(session);
    const secretStore = new Map<string, string>();
    const envValues = new Map<string, string>();
    const abortController = new AbortController();
    const exec = createExecService();
    const agents = {
        cli: {
            async checkReadiness(query) {
                return {
                    status: 'missing',
                    launchable: [],
                    missing: query.candidates.map((agentId) => ({ agentId, status: 'missing' })),
                    blocked: [],
                };
            },
        },
    } satisfies PluginContextV1['agentRuntime']['agents'];
    const terminalHost = {
        resolve: () => notConfigured('terminalHost.resolve'),
        createOrAttachHost: () => notConfigured('terminalHost.createOrAttachHost'),
        injectUserPrompt: () => notConfigured('terminalHost.injectUserPrompt'),
        interruptTurn: () => notConfigured('terminalHost.interruptTurn'),
        evaluateLiveness: () => notConfigured('terminalHost.evaluateLiveness'),
        captureInputState: () => notConfigured('terminalHost.captureInputState'),
        controlPort: () => notConfigured('terminalHost.controlPort'),
        dispose: () => notConfigured('terminalHost.dispose'),
    } satisfies TerminalHostRuntimeServiceV1;
    const sessionHooks = {
        startServer: () => notConfigured('sessionHooks.startServer'),
        resolveForwarderAssets: () => notConfigured('sessionHooks.resolveForwarderAssets'),
        createPluginDir: () => notConfigured('sessionHooks.createPluginDir'),
        async disposePluginDir() {
            return undefined;
        },
        async publishProviderTranscript() {
            return undefined;
        },
    } satisfies SessionHooksRuntimeServiceV1;
    const acp = {
        defineAcpBackend: () => failNotConfigured('acp.defineAcpBackend'),
        createRuntime: () => notConfigured('acp.createRuntime'),
    } satisfies PluginContextV1['agentRuntime']['acp'];
    const accountUsage = {
        async resolveSourceContext(input) {
            return {
                serviceId: input.serviceId,
                profileId: 'fixture-profile',
                bindingKind: 'profile',
            };
        },
        async recordSnapshot() {
            return { status: 'unavailable', reason: 'session_scope_unavailable' };
        },
        async adoptProvisionalRecord() {
            return { status: 'unavailable', reason: 'session_scope_unavailable' };
        },
    } satisfies PluginContextV1['agentRuntime']['accountUsage'];
    const transcripts = {
        async append(turn) {
            records.transcriptAppends.push(turn);
        },
        async defineSource(definition) {
            records.transcriptSourceDefinitions.push(definition);
            return {
                id: definition.id,
                async dispose() {
                    return undefined;
                },
            };
        },
        fileFollow: {
            follow: () => notConfigured('transcripts.fileFollow.follow'),
        },
    } satisfies TranscriptsRuntimeServiceV1;
    const ctx: PluginContextV1 = {
        logger,
        config,
        features,
        permissions,
        agentRuntime: Object.freeze({
            exec,
            agents,
            terminalHost,
            sessionHooks,
            acp,
            accountUsage,
            transcripts,
        }),
        managedServer: createManagedServerService(),
        localServices: createLocalServices(),
        mcp: createMcpService(),
        errors: {
            classify(error) {
                return {
                    kind: 'unknown',
                    code: null,
                    message: error instanceof Error ? error.message : String(error),
                    retryable: false,
                };
            },
            wrap(error, fallbackCode) {
                if (error instanceof Error) return error;
                return new Error(fallbackCode ? `${fallbackCode}: ${String(error)}` : String(error));
            },
            report(error, fields) {
                records.logs.push({
                    level: 'error',
                    message: error instanceof Error ? error.message : String(error),
                    fields,
                });
            },
        } satisfies ErrorRuntimeServiceV1,
        retry: {
            async wrap(operation, policy) {
                return operation({ attempt: 1, maxAttempts: policy.maxAttempts, signal: policy.signal });
            },
        } satisfies RetryRuntimeServiceV1,
        env: {
            get(name) {
                return envValues.get(name) ?? null;
            },
            require(name) {
                const value = envValues.get(name);
                if (value === undefined) throw new Error(`Missing required fixture env value "${name}"`);
                return value;
            },
            list(prefix) {
                return Object.fromEntries([...envValues.entries()].filter(([key]) => !prefix || key.startsWith(prefix)));
            },
        } satisfies EnvRuntimeServiceV1,
        fs: {
            readText: () => notConfigured('fs.readText'),
            async writeText() {
                return undefined;
            },
            async mkdir() {
                return undefined;
            },
            async list() {
                return [];
            },
            async stat() {
                return null;
            },
            async createTempDirectory(): Promise<FsTempDirectoryV1> {
                return notConfigured('fs.createTempDirectory');
            },
        } satisfies FsRuntimeServiceV1,
        actions: createActionsService(),
        connection: {
            getDaemonLinkState() {
                return {
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                };
            },
            watchDaemonLink() {
                return createSubscription();
            },
            isDaemonOnline() {
                return true;
            },
        } satisfies ConnectionRuntimeServiceV1,
        fetch: options.fetch ?? createDefaultFetch(records),
        storage: {
            ephemeral: createStorageScope(),
            session: createStorageScope(),
            local: createStorageScope(),
            synced: createStorageScope(),
        },
        settings: createSettingsService(),
        secrets: {
            async get(name) {
                return secretStore.get(name) ?? null;
            },
            async set(name, value) {
                secretStore.set(name, value);
            },
            async delete(name) {
                secretStore.delete(name);
            },
            async list() {
                return [...secretStore.keys()].map((name) => ({ name }));
            },
        },
        events,
        auth: createAuthService(),
        projects: {
            async listAll() {
                return [];
            },
            async listForCurrentMachine() {
                return [];
            },
            async listForMachine() {
                return [];
            },
            async get() {
                return null;
            },
            async getActive() {
                return null;
            },
            watch(_listener: ProjectsChangeListenerV1) {
                return createSubscription();
            },
        },
        account: {
            settings: createAccountSettingsService(),
        },
        reviews: createReviewsService(),
        sessions,
        experimental: {
            telemetry,
            artifacts,
        },
        notifications: {
            async send() {
                return { delivered: [] };
            },
            async listChannels() {
                return [];
            },
            async listCategories() {
                return [];
            },
            async getUserPreferences(categoryId) {
                return { categoryId, channels: [] };
            },
        },
        abort: {
            signal: abortController.signal,
            compose(signals) {
                const controller = new AbortController();
                for (const signal of signals) {
                    if (signal.aborted) controller.abort(signal.reason);
                    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
                }
                return controller.signal;
            },
            async race(operation, signal) {
                if (signal?.aborted) throw signal.reason;
                return operation;
            },
            onHeartbeat() {
                return createSubscription();
            },
        },
        timeout: {
            async withMs(_timeoutMs, operation, signal) {
                return operation(signal ?? new AbortController().signal);
            },
            async withBudget(_budget, operation, signal) {
                return operation(signal ?? new AbortController().signal);
            },
        },
        progress: createProgressService(),
    };

    return {
        ctx,
        records,
        services: {
            writeMetadata: session.writeMetadata,
            writeAgentState: session.writeAgentState,
            writeStateField: session.writeStateField,
            requestPermissionDecision: session.permissions.requestDecision,
        },
    };
}
