import { describe, expect, it } from 'vitest';

describe('copyRuntimePayloadTree Windows long-path helper', () => {
    it('adds a long-path prefix for absolute drive paths on Windows', async () => {
        const runtimePayloadTree = await import('./copyRuntimePayloadTree');
        const toFsPath = (runtimePayloadTree as Record<string, unknown>).toWindowsExtendedLengthPathForFs;

        expect(typeof toFsPath).toBe('function');
        expect(
            (toFsPath as (pathLike: string, platform?: NodeJS.Platform) => string)(
                'C:\\Users\\tester\\payload\\node_modules\\pkg\\package.json',
                'win32',
            ),
        ).toBe('\\\\?\\C:\\Users\\tester\\payload\\node_modules\\pkg\\package.json');
    });

    it('adds UNC long-path prefix for network shares on Windows', async () => {
        const runtimePayloadTree = await import('./copyRuntimePayloadTree');
        const toFsPath = (runtimePayloadTree as Record<string, unknown>).toWindowsExtendedLengthPathForFs;

        expect(typeof toFsPath).toBe('function');
        expect(
            (toFsPath as (pathLike: string, platform?: NodeJS.Platform) => string)(
                '\\\\server\\share\\payload\\pkg\\index.mjs',
                'win32',
            ),
        ).toBe('\\\\?\\UNC\\server\\share\\payload\\pkg\\index.mjs');
    });

    it('keeps non-Windows paths unchanged', async () => {
        const runtimePayloadTree = await import('./copyRuntimePayloadTree');
        const toFsPath = (runtimePayloadTree as Record<string, unknown>).toWindowsExtendedLengthPathForFs;

        expect(typeof toFsPath).toBe('function');
        expect(
            (toFsPath as (pathLike: string, platform?: NodeJS.Platform) => string)(
                '/tmp/payload/package.json',
                'darwin',
            ),
        ).toBe('/tmp/payload/package.json');
    });
});
