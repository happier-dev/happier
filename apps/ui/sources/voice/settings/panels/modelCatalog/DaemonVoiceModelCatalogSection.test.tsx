import * as React from 'react';

import { act, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonVoiceInferenceClient } from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';
import type { DaemonVoiceInferenceModelStatus } from '@happier-dev/protocol';
import {
    getDefaultModelPackId,
    listModelPackCatalogEntries,
} from '@happier-dev/protocol';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

import { DaemonVoiceModelCatalogSection } from './DaemonVoiceModelCatalogSection';

type Client = Pick<DaemonVoiceInferenceClient, 'getModelsStatus' | 'installModel' | 'removeModel'>;

function renderSection(
    client: Client,
    props?: Partial<React.ComponentProps<typeof DaemonVoiceModelCatalogSection>>,
): Promise<ReactTestRenderer> {
    return renderScreen(
        <DaemonVoiceModelCatalogSection
            selectedSttPackId={null}
            selectedTtsPackId={null}
            onSelectDefault={() => undefined}
            client={client}
            {...props}
        />,
    ).then((result) => result.tree);
}

function status(
    packId: string,
    overrides: Partial<DaemonVoiceInferenceModelStatus> = {},
): DaemonVoiceInferenceModelStatus {
    const entry = listModelPackCatalogEntries().find((candidate) => candidate.packId === packId);
    return {
        packId,
        kind: entry?.kind ?? 'tts_sherpa',
        model: entry?.model ?? packId,
        version: null,
        executionSupport: ['daemon'],
        installState: 'installed',
        progress: null,
        lastError: null,
        updatedAtMs: 0,
        runtimeState: 'cold',
        ...overrides,
    };
}

describe('DaemonVoiceModelCatalogSection', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('shows a loading status row before the daemon status resolves', async () => {
        let resolveStatus: (value: DaemonVoiceInferenceModelStatus[]) => void = () => undefined;
        const getModelsStatus = vi.fn(
            () => new Promise<DaemonVoiceInferenceModelStatus[]>((resolve) => {
                resolveStatus = resolve;
            }),
        );
        const client: Client = {
            getModelsStatus,
            installModel: vi.fn(async () => undefined as never),
            removeModel: vi.fn(async () => undefined),
        };

        const tree = await renderSection(client);
        // The status row should surface the loading state while the RPC is pending.
        const status = tree.root.findByProps({ testID: 'voice-model-catalog-status' });
        expect(status.props.detail).toBe('Loading…');

        await act(async () => {
            resolveStatus([]);
            await Promise.resolve();
        });
    });

    it('surfaces a daemon error and renders rows as uninstallable when status fails', async () => {
        const installModel = vi.fn(async () => undefined as never);
        const getModelsStatus = vi.fn(async () => {
            throw Object.assign(new Error('down'), { code: 'machine_unreachable' });
        });
        const client: Client = {
            getModelsStatus,
            installModel,
            removeModel: vi.fn(async () => undefined),
        };

        const tree = await renderSection(client);
        await act(async () => {
            await Promise.resolve();
        });

        const status = tree.root.findByProps({ testID: 'voice-model-catalog-status' });
        expect(status.props.detail).toBe('Voice-home daemon unavailable.');
        expect(status.props.destructive).toBe(true);

        // With the daemon health unknown, every model row is inert: it exposes
        // no press handler at all, so a tap cannot fire an install/remove
        // against the unreachable daemon.
        const rows = tree.root.findAll(
            (node) => typeof node.props?.testID === 'string'
                && node.props.testID.startsWith('voice-model-row-'),
        );
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(row.props.onPress ?? row.props.onClick).toBeUndefined();
        }
        expect(installModel).not.toHaveBeenCalled();
    });

    it('can render from an already-created catalog controller without opening a second status request', async () => {
        const sttDefault = getDefaultModelPackId('stt_sherpa')!;
        const getModelsStatus = vi.fn(async () => {
            throw new Error('should not be called');
        });
        const client: Client = {
            getModelsStatus,
            installModel: vi.fn(async () => undefined as never),
            removeModel: vi.fn(async () => undefined),
        };

        const tree = await renderSection(client, {
            catalogController: {
                state: {
                    statuses: [status(sttDefault, { kind: 'stt_sherpa', runtimeState: 'ready' })],
                    errorCode: null,
                    loading: false,
                    actionPackId: null,
                },
                refresh: vi.fn(async () => undefined),
                install: vi.fn(async () => undefined),
                remove: vi.fn(async () => undefined),
            } as any,
        });

        const row = tree.root.findByProps({ testID: `voice-model-row-${sttDefault}` });
        expect(row.props.detail).toBe('Ready');
        expect(getModelsStatus).not.toHaveBeenCalled();
    });

    it('selects an installed non-default row as default instead of removing it', async () => {
        const ttsDefault = getDefaultModelPackId('tts_sherpa')!;
        const alternateTtsPack = listModelPackCatalogEntries('tts_sherpa')
            .find((entry) => entry.packId !== ttsDefault)!.packId;
        const onSelectDefault = vi.fn();
        const removeModel = vi.fn(async () => undefined);
        const client: Client = {
            getModelsStatus: vi.fn(async () => [
                status(ttsDefault),
                status(alternateTtsPack),
            ]),
            installModel: vi.fn(async () => undefined as never),
            removeModel,
        };

        const tree = await renderSection(client, {
            selectedTtsPackId: ttsDefault,
            onSelectDefault,
        });
        await act(async () => {
            await Promise.resolve();
        });

        const row = tree.root.findByProps({ testID: `voice-model-row-${alternateTtsPack}` });
        await act(async () => {
            await pressTestInstanceAsync(row);
        });

        expect(onSelectDefault).toHaveBeenCalledWith('tts_sherpa', alternateTtsPack);
        expect(removeModel).not.toHaveBeenCalled();
        expect(tree.root.findByProps({ testID: `voice-model-remove-${alternateTtsPack}` })).toBeTruthy();
    });
});
