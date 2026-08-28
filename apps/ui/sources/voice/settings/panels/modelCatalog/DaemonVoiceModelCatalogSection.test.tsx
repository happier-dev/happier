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

const confirmSpy = vi.hoisted(() => vi.fn());

vi.mock('@/modal', async () => {
    const actual = await vi.importActual<typeof import('@/modal')>('@/modal');
    return { ...actual, Modal: { ...actual.Modal, confirm: confirmSpy } };
});

type Client = Pick<DaemonVoiceInferenceClient, 'getModelsStatus' | 'installModel' | 'removeModel'>;

function catalogClient(client: Client): Pick<
    DaemonVoiceInferenceClient,
    'listModels' | 'getModelsStatus' | 'installModel' | 'acceptModelPackLicense' | 'removeModel'
> {
    return {
        listModels: (scope) => client.getModelsStatus(undefined, scope),
        getModelsStatus: async () => [],
        installModel: client.installModel.bind(client),
        acceptModelPackLicense: vi.fn(async () => status(getDefaultModelPackId('stt_sherpa')!)),
        removeModel: client.removeModel.bind(client),
    };
}

function renderSection(
    client: Client,
    props?: Partial<React.ComponentProps<typeof DaemonVoiceModelCatalogSection>>,
): Promise<ReactTestRenderer> {
    return renderScreen(
        <DaemonVoiceModelCatalogSection
            selectedSttPackId={null}
            selectedTtsPackId={null}
            onSelectDefault={() => undefined}
            client={catalogClient(client)}
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
        pluginIdentity: null,
        kind: entry?.kind ?? 'tts_sherpa',
        model: entry?.model ?? packId,
        version: null,
        executionSupport: ['daemon'],
        runtimeFamily: entry?.runtimeFamily ?? null,
        runtimeSupported: true,
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
        confirmSpy.mockReset();
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
                    actionError: null,
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

    it('keeps an installed but unavailable non-default pack non-selectable and removable', async () => {
        const ttsDefault = getDefaultModelPackId('tts_sherpa')!;
        const unavailableTtsPack = listModelPackCatalogEntries('tts_sherpa')
            .find((entry) => (
                entry.packId !== ttsDefault
                && entry.publicationStatus === 'unavailable'
            ))!.packId;
        const onSelectDefault = vi.fn();
        const removeModel = vi.fn(async () => undefined);
        const client: Client = {
            getModelsStatus: vi.fn(async () => [
                status(ttsDefault),
                status(unavailableTtsPack),
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

        const row = tree.root.findByProps({ testID: `voice-model-row-${unavailableTtsPack}` });
        expect(row.props.onPress ?? row.props.onClick).toBeUndefined();
        expect(onSelectDefault).not.toHaveBeenCalled();
        expect(removeModel).not.toHaveBeenCalled();
        expect(tree.root.findByProps({ testID: `voice-model-remove-${unavailableTtsPack}` })).toBeTruthy();
    });

    it('keeps a selected installed unsupported pack inert but removable for recovery', async () => {
        const unsupportedPack = listModelPackCatalogEntries('stt_sherpa')
            .find((entry) => entry.runtimeFamily === 'sherpa_parakeet_offline')!;
        const tree = await renderSection({
            getModelsStatus: vi.fn(async () => []),
            installModel: vi.fn(async () => undefined as never),
            removeModel: vi.fn(async () => undefined),
        }, {
            selectedSttPackId: unsupportedPack.packId,
            catalogController: {
                state: {
                    statuses: [status(unsupportedPack.packId, {
                        runtimeSupported: false,
                        installState: 'installed',
                    })],
                    errorCode: null,
                    loading: false,
                    actionPackId: null,
                    actionError: null,
                },
                refresh: vi.fn(async () => undefined),
                install: vi.fn(async () => undefined),
                remove: vi.fn(async () => undefined),
            } as any,
        });

        const row = tree.root.findByProps({ testID: `voice-model-row-${unsupportedPack.packId}` });
        expect(row.props.onPress ?? row.props.onClick).toBeUndefined();
        expect(tree.root.findByProps({ testID: `voice-model-remove-${unsupportedPack.packId}` })).toBeTruthy();
    });

    it('reviews and accepts the exact external-pack license binding before installing', async () => {
        const packId = 'acme.speech/english-small';
        const review = {
            pluginId: 'acme.speech',
            packId: 'english-small',
            pluginVersion: '1.2.3',
            packVersion: '2026.7.0',
            licenseId: 'acme-model-license-v1',
            licenseTitle: 'Acme model license',
            licenseText: 'Review these exact model terms.',
            licenseSourceUrl: 'https://example.com/licenses/acme-v1',
            licenseTextDigest: `sha256:${'a'.repeat(64)}`,
            artifactBinding: { kind: 'sourceIntegrity', integrity: `sha256:${'b'.repeat(64)}` },
            accepted: false,
        } as const;
        const acceptLicense = vi.fn(async () => undefined);
        const installAfterReview = vi.fn(async () => undefined);
        const install = vi.fn(async (
            _packId: string,
            prepare?: (isCurrent: () => boolean) => Promise<boolean>,
        ) => {
            if (prepare && !(await prepare(() => true))) return;
            await installAfterReview();
        });
        confirmSpy.mockResolvedValueOnce(true);
        const tree = await renderSection({
            getModelsStatus: vi.fn(async () => []),
            installModel: vi.fn(async () => undefined as never),
            removeModel: vi.fn(async () => undefined),
        }, {
            catalogController: {
                state: {
                    statuses: [status(packId, {
                        pluginIdentity: { pluginId: 'acme.speech', packId: 'english-small' },
                        kind: 'stt_sherpa',
                        model: 'acme-english-small',
                        version: '2026.7.0',
                        runtimeFamily: 'sherpa_zipformer_streaming',
                        runtimeSupported: true,
                        installState: 'not_installed',
                        licenseReview: review,
                    })],
                    errorCode: null,
                    loading: false,
                    actionPackId: null,
                    actionError: null,
                },
                refresh: vi.fn(async () => undefined),
                install,
                acceptLicense,
                remove: vi.fn(async () => undefined),
            },
        });

        await act(async () => {
            await pressTestInstanceAsync(tree.root.findByProps({ testID: `voice-model-row-${packId}` }));
            await Promise.resolve();
        });

        expect(confirmSpy).toHaveBeenCalledWith(
            review.licenseTitle,
            review.licenseText,
            expect.objectContaining({ confirmText: expect.any(String) }),
        );
        expect(acceptLicense).toHaveBeenCalledWith(review);
        expect(install).toHaveBeenCalledWith(packId, expect.any(Function));
        expect(acceptLicense.mock.invocationCallOrder[0]).toBeLessThan(
            installAfterReview.mock.invocationCallOrder[0]!,
        );
    });

    it('makes every competing model action inert while the catalog mutation owner is active', async () => {
        const sttPack = getDefaultModelPackId('stt_sherpa')!;
        const ttsPack = getDefaultModelPackId('tts_sherpa')!;
        const tree = await renderSection({
            getModelsStatus: vi.fn(async () => []),
            installModel: vi.fn(async () => undefined as never),
            removeModel: vi.fn(async () => undefined),
        }, {
            catalogController: {
                state: {
                    statuses: [status(sttPack), status(ttsPack)],
                    errorCode: null,
                    loading: false,
                    actionPackId: sttPack,
                    actionError: null,
                },
                refresh: vi.fn(async () => undefined),
                install: vi.fn(async () => undefined),
                acceptLicense: vi.fn(async () => undefined),
                remove: vi.fn(async () => undefined),
            },
        });

        const competingRow = tree.root.findByProps({ testID: `voice-model-row-${ttsPack}` });
        const competingRemove = tree.root.findByProps({ testID: `voice-model-remove-${ttsPack}` });
        expect(competingRow.props.onPress ?? competingRow.props.onClick).toBeUndefined();
        expect(competingRow.props.disabled).toBe(true);
        expect(competingRemove.props.disabled).toBe(true);
        expect(competingRemove.props.accessibilityState).toEqual({ disabled: true });
    });
});
