import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSessionFilesHookCommonModuleMocks } from './sessionFilesHookTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const warmSpy = vi.fn();

installSessionFilesHookCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'filesRepositoryTreeWarmCacheEnabled') return true;
                return null;
            },
        });
    },
});

vi.mock('@/sync/domains/input/repositoryDirectory', () => ({
    warmRepositoryDirectoryCache: (input: any) => warmSpy(input),
}));

function Harness(props: Readonly<{
    sessionId: string;
    sessionPath: string | null;
    machineOnline: boolean;
    run: (input: Readonly<{ sessionId: string; sessionPath: string | null; machineOnline: boolean }>) => void;
}>) {
    props.run({
        sessionId: props.sessionId,
        sessionPath: props.sessionPath,
        machineOnline: props.machineOnline,
    });
    return React.createElement('View');
}

describe('useWarmRepositoryDirectoryCacheOnSessionOpen', () => {
    it('warms the repository root directory cache on web', async () => {
        warmSpy.mockResolvedValue({ ok: true, entries: [] });

        const { useWarmRepositoryDirectoryCacheOnSessionOpen } = await import('./useWarmRepositoryDirectoryCacheOnSessionOpen');
        await renderScreen(
            <Harness
                sessionId="s1"
                sessionPath="/repo"
                machineOnline={true}
                run={useWarmRepositoryDirectoryCacheOnSessionOpen}
            />
        );

        expect(warmSpy).toHaveBeenCalledWith({ sessionId: 's1', directoryPath: '' });
    });

    it('does not warm when session path is missing', async () => {
        warmSpy.mockClear();
        const { useWarmRepositoryDirectoryCacheOnSessionOpen } = await import('./useWarmRepositoryDirectoryCacheOnSessionOpen');
        await renderScreen(
            <Harness
                sessionId="s1"
                sessionPath={null}
                machineOnline={true}
                run={useWarmRepositoryDirectoryCacheOnSessionOpen}
            />
        );
        expect(warmSpy).not.toHaveBeenCalled();
    });
});
