type EnvValue = string | undefined;

export function createEnvPatcher(keys: readonly string[]) {
    const original = new Map<string, EnvValue>();
    for (const key of keys) {
        original.set(key, process.env[key]);
    }

    const set = (key: string, value: EnvValue): void => {
        if (value === undefined) {
            delete process.env[key];
            return;
        }
        process.env[key] = value;
    };

    const setMany = (patch: Record<string, EnvValue>): void => {
        for (const [key, value] of Object.entries(patch)) {
            set(key, value);
        }
    };

    const restore = (): void => {
        for (const key of keys) {
            set(key, original.get(key));
        }
    };

    return { set, setMany, restore };
}
