import * as React from 'react';

import { act, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonVoiceInferenceClient } from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';
import type { DaemonVoiceInferenceModelStatus } from '@happier-dev/protocol';
import { listModelPackCatalogEntries } from '@happier-dev/protocol';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

import { useDaemonVoiceModelCatalogState } from './useDaemonVoiceModelCatalogState';

const STT_PACK = listModelPackCatalogEntries('stt_sherpa')[0]!.packId;

function status(
    packId: string,
    overrides: Partial<DaemonVoiceInferenceModelStatus> = {},
): DaemonVoiceInferenceModelStatus {
    const entry = listModelPackCatalogEntries().find((candidate) => candidate.packId === packId);
    return {
        packId,
        kind: entry?.kind ?? 'stt_sherpa',
        model: entry?.model ?? packId,
        version: null,
        executionSupport: ['daemon'],
        installState: 'not_installed',
        progress: null,
        lastError: null,
        updatedAtMs: 0,
        ...overrides,
    };
}

function TestHarness(props: Readonly<{
    client: Pick<DaemonVoiceInferenceClient, 'getModelsStatus' | 'installModel' | 'removeModel'>;
    enabled?: boolean;
}>): React.ReactElement {
    const { state, install } = useDaemonVoiceModelCatalogState({
        client: props.client,
        pollIntervalMs: 100,
        enabled: props.enabled,
    });
    const sttStatus = state.statuses.find((candidate) => candidate.packId === STT_PACK);
    return (
        <>
            {React.createElement('State', {
                installState: sttStatus?.installState ?? null,
                count: state.statuses.length,
                actionPackId: state.actionPackId,
            })}
            {React.createElement('InstallButton', { onPress: () => install(STT_PACK) })}
        </>
    );
}

describe('useDaemonVoiceModelCatalogState', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('requests every catalog pack id on refresh', async () => {
        const getModelsStatus = vi.fn(
            async (_packIds?: readonly string[] | null): Promise<DaemonVoiceInferenceModelStatus[]> => [],
        );
        const installModel = vi.fn(async () => status(STT_PACK));
        const removeModel = vi.fn(async () => undefined);

        await renderScreen(
            <TestHarness client={{ getModelsStatus, installModel, removeModel }} />,
        );
        await act(async () => {
            await Promise.resolve();
        });

        const requested = getModelsStatus.mock.calls[0]?.[0] ?? [];
        const catalogIds = listModelPackCatalogEntries().map((entry) => entry.packId).sort();
        expect([...requested].sort()).toEqual(catalogIds);
    });

    it('does not open a daemon model status request while disabled', async () => {
        const getModelsStatus = vi.fn(
            async (_packIds?: readonly string[] | null): Promise<DaemonVoiceInferenceModelStatus[]> => [],
        );
        const installModel = vi.fn(async () => status(STT_PACK));
        const removeModel = vi.fn(async () => undefined);

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(
            <TestHarness
                client={{ getModelsStatus, installModel, removeModel }}
                enabled={false}
            />,
        )).tree;
        await act(async () => {
            await Promise.resolve();
        });

        expect(getModelsStatus).not.toHaveBeenCalled();
        expect(tree.root.findByType('State').props.count).toBe(0);
    });

    it('polls until an installing pack reports installed', async () => {
        const getModelsStatus = vi.fn(async () => [status(STT_PACK)]);
        getModelsStatus
            .mockImplementationOnce(async () => [status(STT_PACK, { installState: 'not_installed' })])
            .mockImplementationOnce(async () => [status(STT_PACK, {
                installState: 'installing',
                progress: { phase: 'downloading', progress: 0.5, bytesDownloaded: 50, totalBytes: 100, message: null },
            })])
            .mockImplementationOnce(async () => [status(STT_PACK, { installState: 'installed' })]);
        const installModel = vi.fn(async () => status(STT_PACK, {
            installState: 'installing',
            progress: { phase: 'downloading', progress: 0.1, bytesDownloaded: 10, totalBytes: 100, message: null },
        }));
        const removeModel = vi.fn(async () => undefined);

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(
            <TestHarness client={{ getModelsStatus, installModel, removeModel }} />,
        )).tree;
        await act(async () => {
            await Promise.resolve();
        });

        await act(async () => {
            await pressTestInstanceAsync(tree.root.findByType('InstallButton'));
        });
        expect(installModel).toHaveBeenCalledWith({ packId: STT_PACK });
        expect(tree.root.findByType('State').props.installState).toBe('installing');

        await act(async () => {
            vi.advanceTimersByTime(100);
            await Promise.resolve();
        });
        expect(tree.root.findByType('State').props.installState).toBe('installed');
    });

    it('surfaces the daemon error code when the status request fails', async () => {
        const getModelsStatus = vi.fn(async () => {
            throw Object.assign(new Error('down'), { code: 'machine_unreachable' });
        });
        const installModel = vi.fn(async () => status(STT_PACK));
        const removeModel = vi.fn(async () => undefined);
        // Stable client reference: an inline literal would change identity every
        // render, re-running the refresh effect and looping.
        const client = { getModelsStatus, installModel, removeModel };

        function ErrorHarness(): React.ReactElement {
            const { state } = useDaemonVoiceModelCatalogState({ client });
            return React.createElement('Err', { errorCode: state.errorCode });
        }

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(<ErrorHarness />)).tree;
        await act(async () => {
            await Promise.resolve();
        });
        expect(tree.root.findByType('Err').props.errorCode).toBe('machine_unreachable');
    });

    it('collapses an unrecognized daemon failure code to internal_error', async () => {
        const getModelsStatus = vi.fn(async () => {
            throw Object.assign(new Error('weird'), { code: 'quota_exceeded' });
        });
        const installModel = vi.fn(async () => status(STT_PACK));
        const removeModel = vi.fn(async () => undefined);
        const client = { getModelsStatus, installModel, removeModel };

        function ErrorHarness(): React.ReactElement {
            const { state } = useDaemonVoiceModelCatalogState({ client });
            return React.createElement('Err', { errorCode: state.errorCode });
        }

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(<ErrorHarness />)).tree;
        await act(async () => {
            await Promise.resolve();
        });
        // An out-of-union code must not leak through as a non-error/"ready" state.
        expect(tree.root.findByType('Err').props.errorCode).toBe('internal_error');
    });
});
