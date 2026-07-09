type ManifestFixtureOverrides = Readonly<Record<string, unknown>>;

function normalizeUses(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
}

function normalizePermissions(value: unknown): Readonly<{
    required: readonly unknown[];
    optional: readonly unknown[];
}> {
    if (Array.isArray(value)) {
        return { required: value, optional: [] };
    }
    if (typeof value === 'object' && value !== null) {
        const record = value as Readonly<Record<string, unknown>>;
        return {
            required: Array.isArray(record.required) ? record.required : [],
            optional: Array.isArray(record.optional) ? record.optional : [],
        };
    }
    return { required: [], optional: [] };
}

export function createPluginManifestV2Fixture(
    overrides: ManifestFixtureOverrides = {},
): Readonly<Record<string, unknown>> {
    const manifest: Record<string, unknown> = {
        schemaVersion: 2,
        id: 'acme.test',
        version: '1.0.0',
        displayName: 'Acme Test Manifest',
        description: 'Test manifest',
        engines: {
            happier: '^0.2.0',
        },
        uses: [],
        entrypoints: {
            main: './daemon.mjs',
        },
        permissions: {
            required: [],
            optional: [],
        },
        contributes: {},
        ...overrides,
    };

    manifest.uses = normalizeUses(manifest.uses);
    manifest.permissions = normalizePermissions(manifest.permissions);

    return manifest;
}
