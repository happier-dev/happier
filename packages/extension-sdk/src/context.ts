export interface LoggerServiceV1 {
    debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
    info(message: string, fields?: Readonly<Record<string, unknown>>): void;
    warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
    error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface ConfigSnapshotServiceV1 {
    // Read-only view. The host may choose to expose only a safe subset.
    readonly values: Readonly<Record<string, unknown>>;
}

export interface FeaturesServiceV1 {
    isEnabled(featureId: string): boolean;
}

export interface ManagedToolsServiceV1 {
    // Intentionally minimal: concrete spawn/resolve shapes are owned by the runtime lane.
    // This service exists to prevent extensions from importing host internals for tool resolution/spawn.
    resolve(toolId: string): Promise<unknown>;
    // Optional in V1: hosts may initially provide only resolution. When provided, this MUST be binary-safe
    // (must not assume a system Node/npm/yarn/etc exists) and must apply host policy.
    spawn?: (request: unknown) => Promise<unknown>;
}

export interface SessionClientServiceV1 {
    // Narrow session I/O port (shape is intentionally opaque in V1).
    send(request: unknown): Promise<unknown>;
    subscribe(request: unknown, onEvent: (event: unknown) => void): SubscriptionV1;
    writeMetadata(request: unknown): Promise<void>;
    writeAgentState(request: unknown): Promise<void>;
}

export interface TranscriptWriterServiceV1 {
    // Narrow streaming write port.
    append(turn: unknown): Promise<void>;
}

export interface PermissionsServiceV1 {
    requestDecision(request: unknown): Promise<unknown>;
    getEffectiveMode(): unknown;
}

export interface TelemetryServiceV1 {
    emit(observation: unknown): void;
}

export interface ArtifactSinkServiceV1 {
    write(record: unknown): Promise<void>;
}

export interface AbortServiceV1 {
    readonly signal: AbortSignal;
}

export interface SubscriptionV1 {
    unsubscribe(): void;
}

export interface ExtensionContextV1 {
    readonly logger: LoggerServiceV1;
    readonly config: ConfigSnapshotServiceV1;
    readonly features: FeaturesServiceV1;
    readonly managedTools: ManagedToolsServiceV1;
    readonly sessions: SessionClientServiceV1;
    readonly transcripts: TranscriptWriterServiceV1;
    readonly permissions: PermissionsServiceV1;
    readonly telemetry: TelemetryServiceV1;
    readonly artifacts: ArtifactSinkServiceV1;
    readonly abort: AbortServiceV1;
}
