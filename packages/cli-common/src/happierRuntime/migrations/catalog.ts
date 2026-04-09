export type HappierRuntimeMigrationEntry = Readonly<{
    id: string;
    boundaryVersion: string;
}>;

export const HAPPIER_RUNTIME_MIGRATION_CATALOG: readonly HappierRuntimeMigrationEntry[] = [
    {
        id: 'v0_2_3-BackgroundServiceAndReleaseChannelMigration',
        boundaryVersion: '0.2.3',
    },
];
