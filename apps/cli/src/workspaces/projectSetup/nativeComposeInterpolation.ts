/** Compose's escaped $$ is literal; default/required expressions still name an input. */
function* interpolationReferences(value: string): Generator<string> {
    for (const token of value.matchAll(/\$\$|\$(?:\{)?([_a-zA-Z][_a-zA-Z0-9]*)/gu)) {
        if (token[1]) yield token[1];
    }
}

/** Inspect references, not values: a conditional or empty secret remains a secret input. */
export function nativeComposeReferencesAnyVariable(value: unknown, names: ReadonlySet<string>): boolean {
    if (typeof value !== 'string') return false;
    for (const name of interpolationReferences(value)) if (names.has(name)) return true;
    return false;
}

/** Names in a native Compose model before interpolation. Values never leave this projection. */
function nativeComposeInterpolationNames(value: unknown): readonly string[] {
    const names = new Set<string>();
    const visit = (entry: unknown): void => {
        if (typeof entry === 'string') {
            for (const name of interpolationReferences(entry)) names.add(name);
        } else if (Array.isArray(entry)) {
            for (const child of entry) visit(child);
        } else if (entry && typeof entry === 'object') {
            for (const child of Object.values(entry)) visit(child);
        }
    };
    visit(value);
    return [...names].sort();
}

/** Native normalization expanded extension fragments; their unused definitions are not inputs to the launch. */
export function nativeComposeSourceInterpolationNames(model: Readonly<Record<string, unknown>>): readonly string[] {
    return nativeComposeInterpolationNames(Object.fromEntries(Object.entries(model).filter(([name]) => !name.startsWith('x-'))));
}
