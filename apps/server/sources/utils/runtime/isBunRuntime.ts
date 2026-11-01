export function isBunRuntime(): boolean {
    const runtime = globalThis as typeof globalThis & { Bun?: unknown };
    return Boolean(runtime.Bun) || Boolean(process.versions.bun);
}
