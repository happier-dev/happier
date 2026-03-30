import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/ops', () => {
    return {
        machinePreviewEnv: vi.fn(async () => {
            // Keep the request pending so the hook stays "loading".
            // This is a true system boundary (daemon RPC) so mocking is appropriate.
            await new Promise(() => {});
            return { supported: true, response: { values: {}, policy: 'redacted' } };
        }),
        machineBash: vi.fn(async () => {
            await new Promise(() => {});
            return { success: false, error: 'not used' };
        }),
    };
});

describe('useEnvironmentVariables (hook)', () => {
    it('sets isLoading=true before consumer useEffect can run', async () => {
        const { useEnvironmentVariables } = await import('./useEnvironmentVariables');
        const hook = await renderHook(
            () => useEnvironmentVariables('m1', ['OPENAI_API_KEY']),
            { flushOptions: { cycles: 0 } },
        );

        expect(hook.getCurrent().isLoading).toBe(true);
        await hook.unmount();
    });

    it('returns empty non-loading state when machine id is missing', async () => {
        const { useEnvironmentVariables } = await import('./useEnvironmentVariables');
        const hook = await renderHook(
            () => useEnvironmentVariables(null, ['OPENAI_API_KEY']),
            { flushOptions: { cycles: 0 } },
        );

        expect(hook.getCurrent().isLoading).toBe(false);
        expect(hook.getCurrent().variables).toEqual({});
        expect(hook.getCurrent().isPreviewEnvSupported).toBe(false);
        await hook.unmount();
    });

    it('finishes immediately when all variable names are invalid', async () => {
        const { useEnvironmentVariables } = await import('./useEnvironmentVariables');
        const hook = await renderHook(
            () => useEnvironmentVariables('m1', ['invalid-name', 'lowercase']),
            { flushOptions: { cycles: 3, turns: 2 } },
        );

        expect(hook.getCurrent().isLoading).toBe(false);
        expect(hook.getCurrent().variables).toEqual({});
        expect(hook.getCurrent().meta).toEqual({});
        await hook.unmount();
    });

    it('forwards serverId routing metadata to preview-env RPC', async () => {
        const { useEnvironmentVariables } = await import('./useEnvironmentVariables');
        const ops = await import('@/sync/ops');

        const hook = await renderHook(
            () => useEnvironmentVariables('m1', ['OPENAI_API_KEY'], { serverId: 'server-b' }),
            { flushOptions: { cycles: 2, turns: 2 } },
        );

        expect(ops.machinePreviewEnv).toHaveBeenCalledWith(
            'm1',
            expect.objectContaining({ keys: ['OPENAI_API_KEY'] }),
            { serverId: 'server-b' },
        );
        await hook.unmount();
    });

    it('forwards serverId routing metadata to bash fallback when preview-env is unsupported', async () => {
        const { useEnvironmentVariables } = await import('./useEnvironmentVariables');
        const ops = await import('@/sync/ops');

        const previewMock = vi.mocked(ops.machinePreviewEnv);
        const bashMock = vi.mocked(ops.machineBash);
        previewMock.mockResolvedValueOnce({ supported: false });
        bashMock.mockResolvedValueOnce({
            success: false,
            stdout: '',
            stderr: 'unsupported',
            exitCode: 1,
        });

        const hook = await renderHook(
            () => useEnvironmentVariables('m1', ['FOO'], { serverId: 'server-b' }),
            { flushOptions: { cycles: 4, turns: 2 } },
        );

        expect(ops.machineBash).toHaveBeenCalledWith(
            'm1',
            expect.any(String),
            '/',
            { serverId: 'server-b' },
        );
        const bashCommand = bashMock.mock.calls.at(-1)?.[1];
        expect(bashCommand).not.toContain('node -e');
        expect(bashCommand).not.toContain('command -v node');
        await hook.unmount();
    });

    it('parses shell-only fallback output for multiline, empty, and unset values', async () => {
        const { useEnvironmentVariables } = await import('./useEnvironmentVariables');
        const ops = await import('@/sync/ops');

        const previewMock = vi.mocked(ops.machinePreviewEnv);
        const bashMock = vi.mocked(ops.machineBash);
        previewMock.mockResolvedValueOnce({ supported: false });
        bashMock.mockResolvedValueOnce({
            success: true,
            stdout: ['S', 'FOO', 'one\ntwo', 'S', 'EMPTY', '', 'U', 'MISSING', '', ''].join('\0'),
            stderr: '',
            exitCode: 0,
        });

        const hook = await renderHook(
            () => useEnvironmentVariables('m1', ['FOO', 'EMPTY', 'MISSING']),
            { flushOptions: { cycles: 4, turns: 2 } },
        );

        expect(hook.getCurrent().variables).toEqual({
            FOO: 'one\ntwo',
            EMPTY: '',
            MISSING: null,
        });
        expect(hook.getCurrent().meta).toMatchObject({
            FOO: { value: 'one\ntwo', isSet: true, display: 'full' },
            EMPTY: { value: '', isSet: true, display: 'full' },
            MISSING: { value: null, isSet: false, display: 'unset' },
        });
        await hook.unmount();
    });
});
