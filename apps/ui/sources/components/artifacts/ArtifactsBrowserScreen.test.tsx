import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, invokeTestInstanceHandler, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { ArtifactQuotaExceededError } from '@/sync/api/artifacts/apiArtifacts';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { useArtifactStorageUsage } from './artifactActionsClient';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit');
    return createTextModuleMock();
});

import { ArtifactsBrowser } from './ArtifactsBrowserScreen';

const initialState = getStorage().getState();
let disposeHome: (() => void) | undefined;
afterEach(async () => {
    await act(async () => {
        disposeHome?.();
        disposeHome = undefined;
        retireActiveServerAccountScopeLifetime();
        invalidateAccountEncryptionModeCache();
        getStorage().setState(initialState, true);
    });
    vi.restoreAllMocks();
});

function MeterBrowser() {
    const usage = useArtifactStorageUsage();
    const artifacts = getStorage()((state) => state.artifacts);
    return <ArtifactsBrowser artifacts={Object.values(artifacts)} loaded loadFailed={false} onRetry={() => {}} usage={usage} />;
}

function RecoveryBrowser({ loadFailed, onRetry, artifacts = [] }: Readonly<{
    loadFailed: boolean; onRetry: () => void; artifacts?: readonly DecryptedArtifact[];
}>) {
    return <AppPaneProvider><ArtifactsBrowser artifacts={artifacts} loaded loadFailed={loadFailed} onRetry={onRetry} usage={null} /></AppPaneProvider>;
}

describe('Artifacts browser recovery', () => {
    it('replaces an already-loaded empty welcome with failure and a working Retry', async () => {
        const retry = vi.fn();
        const screen = await renderScreen(<RecoveryBrowser loadFailed={false} onRetry={retry} />);
        expect(screen.findHostByTestId('artifacts:empty')).not.toBeNull();

        await screen.update(<RecoveryBrowser loadFailed onRetry={retry} />);
        expect(screen.findHostByTestId('artifacts:empty')).toBeNull();
        expect(screen.findHostByTestId('artifacts:failed')).not.toBeNull();
        const retryButton = screen.findAll((node) => typeof node.type === 'string'
            && node.props.accessibilityRole === 'button' && node.props.accessibilityLabel === 'common.retry').at(-1);
        expect(retryButton).toBeDefined();
        await pressTestInstanceAsync(retryButton, 'Retry');
        expect(retry).toHaveBeenCalledOnce();

        await screen.update(<RecoveryBrowser loadFailed={false} onRetry={retry} />);
        expect(screen.findHostByTestId('artifacts:failed')).toBeNull();
        expect(screen.findHostByTestId('artifacts:empty')).not.toBeNull();
    });

    it('keeps hydrated documents visible when a later refresh fails', async () => {
        const artifact: DecryptedArtifact = { id: 'retained', title: 'Notes', isDecrypted: true,
            header: { title: 'Notes' }, headerVersion: 1, bodyVersion: 1, seq: 1,
            body: 'Notes', createdAt: 1, updatedAt: 1, access: 'owner', storageMode: 'plain' };
        const retry = vi.fn();
        const screen = await renderScreen(<RecoveryBrowser artifacts={[artifact]} loadFailed={false} onRetry={retry} />);
        await act(async () => {
            invokeTestInstanceHandler(screen.findHostByTestId('artifacts:collection:stage'), 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } },
            });
        });
        expect(screen.findHostByTestId('artifacts:row:retained')).not.toBeNull();
        await screen.update(<RecoveryBrowser artifacts={[artifact]} loadFailed onRetry={retry} />);
        expect(screen.findHostByTestId('artifacts:row:retained')).not.toBeNull();
        expect(screen.findHostByTestId('artifacts:empty')).toBeNull();
        expect(screen.findHostByTestId('artifacts:failed')).toBeNull();
    });

    it('clears the full-budget banner after quota refusal then deletion without remounting', async () => {
        let usedBytes = 1000;
        const served = await serveActionHomes({
            homes: [{ key: 'owner', serverUrl: 'https://artifact-browser-quota.test', accountId: 'owner' }],
            route: (request) => {
                if (request.path === '/v1/artifacts/storage/usage')
                    return Response.json({ usedBytes, limitBytes: 1000, documentLimitBytes: null, revisionRetentionCount: 10 });
                if (request.path === '/v1/artifacts' && request.method === 'POST')
                    return Response.json({ error: 'quota_exceeded', budget: 'account', limitBytes: 1000, usedBytes }, { status: 413 });
                if (request.path === '/v1/artifacts/document' && request.method === 'DELETE') {
                    usedBytes = 100;
                    return Response.json({ success: true });
                }
                return undefined;
            },
        });
        disposeHome = served.dispose;
        const artifact: DecryptedArtifact = { id: 'document', title: 'Notes', isDecrypted: true,
            header: { title: 'Notes' }, headerVersion: 1, bodyVersion: 1, seq: 1,
            body: 'Notes', createdAt: 1, updatedAt: 1, access: 'owner', storageMode: 'plain' };
        getStorage().getState().addArtifact(artifact);
        getStorage().getState().addArtifact({ ...artifact, id: 'retained' });
        const screen = await renderScreen(<AppPaneProvider><MeterBrowser /></AppPaneProvider>);
        await flushHookEffects();
        expect(screen.findHostByTestId('artifacts:quota')).not.toBeNull();
        expect(screen.findHostByTestId('artifacts:storageMeter')?.props.accessibilityValue.now).toBe(100);

        const account = await captureLazyActionAccountContext(served.homes.owner!.id);
        try {
            await expect(account.workflowArtifacts.create({ artifactId: 'another', header: { title: 'Another document' }, body: 'Content' }))
                .rejects.toBeInstanceOf(ArtifactQuotaExceededError);
            await act(async () => { expect(await account.workflowArtifacts.delete(artifact.id)).toEqual({ ok: true }); });
            await flushHookEffects();
            expect(getStorage().getState().artifacts[artifact.id]).toBeUndefined();
            expect(screen.findHostByTestId('artifacts:quota')).toBeNull();
            expect(screen.findHostByTestId('artifacts:storageMeter')?.props.accessibilityValue.now).toBe(10);
        } finally { account.dispose(); }
    });
});
