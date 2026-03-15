import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useWarmRepositoryDirectoryCacheOnSessionOpen } from './useWarmRepositoryDirectoryCacheOnSessionOpen';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const warmSpy = vi.fn();

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'filesRepositoryTreeWarmCacheEnabled') return true;
        return null;
    },
}));

vi.mock('@/sync/domains/input/repositoryDirectory', () => ({
    warmRepositoryDirectoryCache: (input: any) => warmSpy(input),
}));

function Harness(props: Readonly<{ sessionId: string; sessionPath: string | null; machineOnline: boolean }>) {
    useWarmRepositoryDirectoryCacheOnSessionOpen({
        sessionId: props.sessionId,
        sessionPath: props.sessionPath,
        machineOnline: props.machineOnline,
    });
    return React.createElement('View');
}

describe('useWarmRepositoryDirectoryCacheOnSessionOpen', () => {
    it('warms the repository root directory cache on web', async () => {
        warmSpy.mockResolvedValue({ ok: true, entries: [] });

        await act(async () => {
            renderer.create(<Harness sessionId="s1" sessionPath="/repo" machineOnline={true} />);
        });

        expect(warmSpy).toHaveBeenCalledWith({ sessionId: 's1', directoryPath: '' });
    });

    it('does not warm when session path is missing', async () => {
        warmSpy.mockClear();
        await act(async () => {
            renderer.create(<Harness sessionId="s1" sessionPath={null} machineOnline={true} />);
        });
        expect(warmSpy).not.toHaveBeenCalled();
    });
});
