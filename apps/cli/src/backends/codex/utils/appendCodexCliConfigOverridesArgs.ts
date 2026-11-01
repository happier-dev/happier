type SpawnSpec = Readonly<{ command: string; args: string[] }>;

export function appendCodexCliConfigOverridesArgs(
    spec: SpawnSpec,
    overrides: ReadonlyArray<string>,
): SpawnSpec {
    if (overrides.length === 0) {
        return spec;
    }

    const endOfOptions = spec.args.indexOf('--');
    const insertionIndex = endOfOptions < 0 ? spec.args.length : endOfOptions;
    return {
        command: spec.command,
        args: [
            ...spec.args.slice(0, insertionIndex),
            ...overrides.flatMap((override) => ['-c', override]),
            ...spec.args.slice(insertionIndex),
        ],
    };
}
