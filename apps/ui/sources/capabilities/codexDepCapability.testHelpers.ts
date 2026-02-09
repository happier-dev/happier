import { describe, expect, it, vi } from 'vitest';
import type { CapabilityDetectResult, CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';

type RegistryState =
    | { ok: true; latestVersion: string | null }
    | { ok: false; errorMessage: string };

type DepDataShape = {
    installed: boolean;
    installDir: string;
    binPath: string | null;
    installedVersion: string | null;
    distTag: string;
    lastInstallLogPath: string | null;
    registry?: RegistryState;
};

type CapabilitySuiteConfig<TDepData extends DepDataShape> = {
    suiteName: string;
    depId: CapabilityId;
    distTag: string;
    getDetectResult: (
        results: Partial<Record<CapabilityId, CapabilityDetectResult>> | null | undefined,
    ) => CapabilityDetectResult | null;
    getDepData: (
        results: Partial<Record<CapabilityId, CapabilityDetectResult>> | null | undefined,
    ) => TDepData | null;
    getLatestVersion: (data: TDepData | null | undefined) => string | null;
    getRegistryError: (data: TDepData | null | undefined) => string | null;
    isUpdateAvailable: (data: TDepData | null | undefined) => boolean;
    shouldPrefetchRegistry: (params: {
        result?: CapabilityDetectResult | null;
        data?: TDepData | null;
        requireExistingResult?: boolean;
    }) => boolean;
};

function buildDepData<TDepData extends DepDataShape>(
    distTag: string,
    overrides: Partial<TDepData> = {},
): TDepData {
    return {
        installed: true,
        installDir: '/tmp',
        binPath: '/tmp/bin',
        installedVersion: '1.0.0',
        distTag,
        lastInstallLogPath: null,
        registry: { ok: true, latestVersion: '1.0.1' },
        ...overrides,
    } as TDepData;
}

function buildResults(
    depId: CapabilityId,
    detectResult: CapabilityDetectResult,
): Partial<Record<CapabilityId, CapabilityDetectResult>> {
    return { [depId]: detectResult };
}

export function runCodexDepCapabilityContract<TDepData extends DepDataShape>(
    config: CapabilitySuiteConfig<TDepData>,
): void {
    describe(config.suiteName, () => {
        it('extracts detect result and dep data', () => {
            const detectResult: CapabilityDetectResult = {
                ok: true,
                checkedAt: 123,
                data: buildDepData<TDepData>(config.distTag),
            };

            const results = buildResults(config.depId, detectResult);
            expect(config.getDetectResult(results)).toEqual(detectResult);
            expect(config.getDepData(results)?.installedVersion).toBe('1.0.0');
        });

        it('returns null dep data when detect result is missing or non-ok', () => {
            expect(config.getDetectResult(undefined)).toBeNull();
            expect(config.getDepData(undefined)).toBeNull();

            const nonOk: CapabilityDetectResult = { ok: false, checkedAt: 1, error: { message: 'no' } };
            const results = buildResults(config.depId, nonOk);
            expect(config.getDetectResult(results)?.ok).toBe(false);
            expect(config.getDepData(results)).toBeNull();
        });

        it('derives latest version, update availability, and registry errors', () => {
            const current = config.getDepData(
                buildResults(config.depId, {
                    ok: true,
                    checkedAt: 123,
                    data: buildDepData<TDepData>(config.distTag),
                }),
            );
            expect(config.getLatestVersion(current)).toBe('1.0.1');
            expect(config.isUpdateAvailable(current)).toBe(true);
            expect(config.getRegistryError(current)).toBeNull();

            const installedNewer = config.getDepData(
                buildResults(config.depId, {
                    ok: true,
                    checkedAt: 123,
                    data: buildDepData<TDepData>(config.distTag, { installedVersion: '1.0.2' } as Partial<TDepData>),
                }),
            );
            expect(config.isUpdateAvailable(installedNewer)).toBe(false);

            const nonSemver = config.getDepData(
                buildResults(config.depId, {
                    ok: true,
                    checkedAt: 123,
                    data: buildDepData<TDepData>(config.distTag, { installedVersion: 'main' } as Partial<TDepData>),
                }),
            );
            expect(config.isUpdateAvailable(nonSemver)).toBe(false);

            const registryErrorData = config.getDepData(
                buildResults(config.depId, {
                    ok: true,
                    checkedAt: 123,
                    data: buildDepData<TDepData>(config.distTag, {
                        registry: { ok: false, errorMessage: 'boom' },
                    } as Partial<TDepData>),
                }),
            );
            expect(config.getLatestVersion(registryErrorData)).toBeNull();
            expect(config.isUpdateAvailable(registryErrorData)).toBe(false);
            expect(config.getRegistryError(registryErrorData)).toBe('boom');
        });

        it('prefetches registry only when required by freshness and payload state', () => {
            vi.useFakeTimers();
            try {
                vi.setSystemTime(new Date('2026-02-08T00:00:00.000Z'));
                const now = Date.now();
                const dayMs = 24 * 60 * 60 * 1000;

                expect(
                    config.shouldPrefetchRegistry({
                        requireExistingResult: false,
                        result: null,
                        data: null,
                    }),
                ).toBe(true);
                expect(
                    config.shouldPrefetchRegistry({
                        requireExistingResult: true,
                        result: null,
                        data: null,
                    }),
                ).toBe(false);

                expect(
                    config.shouldPrefetchRegistry({
                        requireExistingResult: true,
                        result: { ok: true, checkedAt: 123, data: {} },
                        data: buildDepData<TDepData>(config.distTag, { registry: undefined } as Partial<TDepData>),
                    }),
                ).toBe(true);

                expect(
                    config.shouldPrefetchRegistry({
                        requireExistingResult: true,
                        result: { ok: true, checkedAt: now, data: {} },
                        data: buildDepData<TDepData>(config.distTag),
                    }),
                ).toBe(false);

                expect(
                    config.shouldPrefetchRegistry({
                        requireExistingResult: true,
                        result: { ok: true, checkedAt: now - 2 * dayMs, data: {} },
                        data: buildDepData<TDepData>(config.distTag),
                    }),
                ).toBe(true);
            } finally {
                vi.useRealTimers();
            }
        });
    });
}
