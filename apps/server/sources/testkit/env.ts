export type EnvValue = string | undefined;
export type EnvValues = Record<string, EnvValue>;

export function snapshotEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
}

export function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
    for (const key of Object.keys(process.env)) {
        if (!(key in snapshot)) {
            delete process.env[key];
        }
    }

    for (const [key, value] of Object.entries(snapshot)) {
        if (typeof value === "string") {
            process.env[key] = value;
            continue;
        }
        delete process.env[key];
    }
}

export function applyEnvValues(values: EnvValues): void {
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) {
            delete process.env[key];
            continue;
        }
        process.env[key] = value;
    }
}

export function snapshotEnvValues(keys: readonly string[]): EnvValues {
    const snapshot: EnvValues = {};

    for (const key of keys) {
        snapshot[key] = process.env[key];
    }

    return snapshot;
}

export function restoreEnvValues(snapshot: EnvValues): void {
    applyEnvValues(snapshot);
}

export function createEnvReset(snapshot = snapshotEnv()) {
    return (overrides: EnvValues = {}): NodeJS.ProcessEnv => {
        restoreEnv(snapshot);
        applyEnvValues(overrides);
        return snapshotEnv();
    };
}

export function createEnvPatcher(keys: readonly string[]) {
    const original = snapshotEnvValues(keys);

    const set = (key: string, value: EnvValue): void => {
        applyEnvValues({ [key]: value });
    };

    const setMany = (patch: EnvValues): void => {
        applyEnvValues(patch);
    };

    const restore = (): void => {
        restoreEnvValues(original);
    };

    return { set, setMany, restore };
}
