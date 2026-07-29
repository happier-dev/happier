type PluginEnvironmentService = Readonly<{
    get(name: string): string | null;
    require(name: string): string;
    list(prefix?: string): Readonly<Record<string, string>>;
}>;

export function createPluginEnvService(params?: Readonly<{
    env?: NodeJS.ProcessEnv;
    allowedNames?: readonly string[];
    allowedPrefixes?: readonly string[];
}>): PluginEnvironmentService {
    const env = params?.env ?? process.env;
    const allowedNames = new Set(params?.allowedNames ?? []);
    const allowedPrefixes = params?.allowedPrefixes ?? [];
    const isAllowed = (name: string): boolean => (
        allowedNames.has(name)
        || allowedPrefixes.some((prefix) => name.startsWith(prefix))
    );

    const service: PluginEnvironmentService = Object.freeze({
        get(name: string): string | null {
            if (!isAllowed(name)) {
                return null;
            }
            const value = env[name];
            return typeof value === 'string' ? value : null;
        },
        require(name: string): string {
            const value = this.get(name);
            if (value === null) {
                throw new Error(`Plugin environment variable '${name}' is unavailable`);
            }
            return value;
        },
        list(prefix?: string): Readonly<Record<string, string>> {
            const result: Record<string, string> = {};
            for (const [name, value] of Object.entries(env)) {
                if (typeof value !== 'string') {
                    continue;
                }
                if (!isAllowed(name)) {
                    continue;
                }
                if (prefix && !name.startsWith(prefix)) {
                    continue;
                }
                result[name] = value;
            }
            return Object.freeze(result);
        },
    });
    return service;
}
