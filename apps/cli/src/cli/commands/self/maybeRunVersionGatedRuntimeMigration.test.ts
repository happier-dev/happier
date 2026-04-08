import { afterEach, describe, expect, it, vi } from 'vitest';

const {
    buildDoctorSnapshotMock,
    buildHappierRuntimeRepairPlanMock,
    handleServiceRepairCliCommandMock,
} = vi.hoisted(() => ({
    buildDoctorSnapshotMock: vi.fn(async () => ({
        capturedAt: '2026-04-08T00:00:00.000Z',
        server: {
            activeServerId: 'cloud',
            serverUrl: 'https://api.happier.dev',
            publicServerUrl: 'https://api.happier.dev',
            webappUrl: 'https://app.happier.dev',
        },
        settings: {
            activeServerId: 'cloud',
            servers: [],
            knownAccountIds: [],
        },
    })),
    buildHappierRuntimeRepairPlanMock: vi.fn<(snapshot: unknown) => { actions: Array<{ kind: string; command: string; mode: string; targetServerUrl: string }>; manualWarnings: unknown[] }>(() => ({
        actions: [{ kind: 'install-default-following-service', command: 'happier service install --yes', mode: 'user', targetServerUrl: 'https://api.happier.dev' }],
        manualWarnings: [],
    })),
    handleServiceRepairCliCommandMock: vi.fn<(params: unknown) => Promise<void>>(async () => {}),
}));

vi.mock('@/ui/doctorSnapshot', () => ({
    buildDoctorSnapshot: () => buildDoctorSnapshotMock(),
}));

vi.mock('@/diagnostics/happierRuntimeRepair', () => ({
    buildHappierRuntimeRepairPlan: (snapshot: unknown) => buildHappierRuntimeRepairPlanMock(snapshot),
}));

vi.mock('../serviceRepair/handleServiceRepairCliCommand', () => ({
    handleServiceRepairCliCommand: (params: unknown) => handleServiceRepairCliCommandMock(params),
}));

describe('maybeRunVersionGatedRuntimeMigration', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        buildDoctorSnapshotMock.mockClear();
        buildHappierRuntimeRepairPlanMock.mockClear();
        handleServiceRepairCliCommandMock.mockClear();
    });

    it('delegates to service repair when an install crosses the 0.2.3 migration boundary and repair work exists', async () => {
        const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

        await expect(maybeRunVersionGatedRuntimeMigration({
            fromVersion: '0.2.2',
            toVersion: '0.2.3',
            argv: ['repair'],
            commandPath: 'happier self migrate',
        })).resolves.toBe(true);

        expect(handleServiceRepairCliCommandMock).toHaveBeenCalledWith({
            argv: ['repair'],
            commandPath: 'happier self migrate',
        });
    });

    it('skips migration when the upgrade did not cross the 0.2.3 boundary', async () => {
        const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

        await expect(maybeRunVersionGatedRuntimeMigration({
            fromVersion: '0.2.3',
            toVersion: '0.2.4',
            argv: ['repair'],
            commandPath: 'happier self migrate',
        })).resolves.toBe(false);

        expect(buildDoctorSnapshotMock).not.toHaveBeenCalled();
        expect(handleServiceRepairCliCommandMock).not.toHaveBeenCalled();
    });
});
