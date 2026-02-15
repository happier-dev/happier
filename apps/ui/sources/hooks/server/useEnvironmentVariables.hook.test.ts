import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { flushHookEffects } from './serverFeatureHookHarness.testHelpers';

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

        let latestIsLoading: boolean | null = null;

        function Test() {
            const res = useEnvironmentVariables('m1', ['OPENAI_API_KEY']);
            latestIsLoading = res.isLoading;
            return React.createElement('View');
        }

        act(() => {
            renderer.create(React.createElement(Test));
        });

        expect(latestIsLoading).toBe(true);
    });

    it('returns empty non-loading state when machine id is missing', async () => {
        const { useEnvironmentVariables } = await import('./useEnvironmentVariables');

        const latestRef: { current: ReturnType<typeof useEnvironmentVariables> | null } = { current: null };
        function Test() {
            latestRef.current = useEnvironmentVariables(null, ['OPENAI_API_KEY']);
            return React.createElement('View');
        }

        act(() => {
            renderer.create(React.createElement(Test));
        });

        if (!latestRef.current) {
            throw new Error('Expected hook result');
        }
        expect(latestRef.current.isLoading).toBe(false);
        expect(latestRef.current.variables).toEqual({});
        expect(latestRef.current.isPreviewEnvSupported).toBe(false);
    });

    it('finishes immediately when all variable names are invalid', async () => {
        const { useEnvironmentVariables } = await import('./useEnvironmentVariables');

        const latestRef: { current: ReturnType<typeof useEnvironmentVariables> | null } = { current: null };
        function Test() {
            latestRef.current = useEnvironmentVariables('m1', ['invalid-name', 'lowercase']);
            return React.createElement('View');
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await flushHookEffects(3);
        });

        if (!latestRef.current) {
            throw new Error('Expected hook result');
        }
        expect(latestRef.current.isLoading).toBe(false);
        expect(latestRef.current.variables).toEqual({});
        expect(latestRef.current.meta).toEqual({});
    });

    it('forwards serverId routing metadata to preview-env RPC', async () => {
        const { useEnvironmentVariables } = await import('./useEnvironmentVariables');
        const ops = await import('@/sync/ops');

        function Test() {
            useEnvironmentVariables('m1', ['OPENAI_API_KEY'], { serverId: 'server-b' });
            return React.createElement('View');
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await flushHookEffects(2);
        });

        expect(ops.machinePreviewEnv).toHaveBeenCalledWith(
            'm1',
            expect.objectContaining({ keys: ['OPENAI_API_KEY'] }),
            { serverId: 'server-b' },
        );
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

        function Test() {
            useEnvironmentVariables('m1', ['FOO'], { serverId: 'server-b' });
            return React.createElement('View');
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await flushHookEffects(4);
        });

        expect(ops.machineBash).toHaveBeenCalledWith(
            'm1',
            expect.any(String),
            '/',
            { serverId: 'server-b' },
        );
    });
});
