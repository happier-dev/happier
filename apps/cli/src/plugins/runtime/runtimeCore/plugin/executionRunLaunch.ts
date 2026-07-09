type PluginExecutionRunLaunchParams = Readonly<{
    cwd: string;
    backendId: string;
    permissionMode: string;
    modelId?: string;
    initialPrompt?: string;
    env?: Readonly<Record<string, string>>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRequiredString(params: Readonly<{
    value: unknown;
    field: string;
}>): string {
    if (typeof params.value !== 'string') {
        throw new Error(`Plugin execution-run launch params require a string ${params.field}`);
    }
    const trimmed = params.value.trim();
    if (trimmed.length === 0) {
        throw new Error(`Plugin execution-run launch params require a non-empty ${params.field}`);
    }
    return trimmed;
}

function readOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    return entries.length > 0 ? Object.freeze(Object.fromEntries(entries)) : undefined;
}

export function buildPluginExecutionRunLaunchParams(raw: unknown): PluginExecutionRunLaunchParams {
    if (!isRecord(raw)) {
        throw new Error('Plugin execution-run launch params must be an object payload');
    }

    return Object.freeze({
        cwd: readRequiredString({
            value: raw.cwd,
            field: 'cwd',
        }),
        backendId: readRequiredString({
            value: raw.backendId,
            field: 'backendId',
        }),
        permissionMode: readRequiredString({
            value: raw.permissionMode,
            field: 'permissionMode',
        }),
        ...(readOptionalString(raw.modelId) ? { modelId: readOptionalString(raw.modelId) } : {}),
        ...(readOptionalString(raw.initialPrompt) ? { initialPrompt: readOptionalString(raw.initialPrompt) } : {}),
        // Isolation/connected-services env for the plugin launch. Parity with the catalog backend
        // path (which merges `isolation.env` into its backend options env) — without this the
        // host-assembled isolation env was silently dropped for plugin engines.
        ...(readOptionalStringRecord(raw.env) ? { env: readOptionalStringRecord(raw.env) } : {}),
    });
}
