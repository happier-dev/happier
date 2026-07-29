type ManifestFixtureOverrides = Readonly<Record<string, unknown>>;

export function createPluginManifestV2Fixture(
    overrides: ManifestFixtureOverrides = {},
): Readonly<Record<string, unknown>> {
    return Object.freeze({
        schemaVersion: 2,
        id: 'acme.test',
        version: '1.0.0',
        displayName: 'Acme Test Manifest',
        description: 'Test manifest',
        engines: {
            happier: '^0.2.0',
        },
        runtime: {
            apiVersion: 1,
        },
        entrypoints: {
            daemon: './daemon.mjs',
        },
        hostAccess: {
            required: [],
            optional: [],
        },
        contributes: {},
        ...overrides,
    });
}
