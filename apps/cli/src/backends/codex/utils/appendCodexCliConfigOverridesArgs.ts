type SpawnSpec = Readonly<{ command: string; args: string[] }>;

export function appendCodexCliConfigOverridesArgs(
    spec: SpawnSpec,
    overrides: ReadonlyArray<string>,
): SpawnSpec {
    if (overrides.length === 0) {
        return spec;
    }

    return {
        command: spec.command,
        args: [
            ...spec.args,
            ...overrides.flatMap((override) => ['-c', override]),
        ],
    };
}
