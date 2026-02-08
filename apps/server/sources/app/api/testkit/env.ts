export function snapshotEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
}

export function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
    for (const key of Object.keys(process.env)) {
        if (!(key in snapshot)) {
            delete (process.env as any)[key];
        }
    }
    for (const [key, value] of Object.entries(snapshot)) {
        if (typeof value === "string") {
            process.env[key] = value;
        }
    }
}
