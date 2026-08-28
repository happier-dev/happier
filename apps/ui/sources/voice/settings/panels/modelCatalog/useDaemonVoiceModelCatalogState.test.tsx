import * as React from 'react';

import { act, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    DaemonVoiceInferenceClient,
    DaemonVoiceInferenceModelMachineScope,
} from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';
import type { DaemonVoiceInferenceModelStatus } from '@happier-dev/protocol';
import { listModelPackCatalogEntries } from '@happier-dev/protocol';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

import { buildModelCatalogRows } from './buildModelCatalogRows';
import { useDaemonVoiceModelCatalogState } from './useDaemonVoiceModelCatalogState';

const STT_PACK = listModelPackCatalogEntries('stt_sherpa')[0]!.packId;

type LegacyTestClient = Pick<DaemonVoiceInferenceClient, 'getModelsStatus' | 'installModel' | 'removeModel'>;

function catalogClient(client: LegacyTestClient): Pick<
    DaemonVoiceInferenceClient,
    'listModels' | 'getModelsStatus' | 'installModel' | 'acceptModelPackLicense' | 'removeModel'
> {
    return {
        listModels: (scope) => client.getModelsStatus(undefined, scope),
        getModelsStatus: async () => [],
        installModel: client.installModel.bind(client),
        acceptModelPackLicense: vi.fn(async () => status(STT_PACK)),
        removeModel: client.removeModel.bind(client),
    };
}

function status(
    packId: string,
    overrides: Partial<DaemonVoiceInferenceModelStatus> = {},
): DaemonVoiceInferenceModelStatus {
    const entry = listModelPackCatalogEntries().find((candidate) => candidate.packId === packId);
    return {
        packId,
        pluginIdentity: null,
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
    client: LegacyTestClient;
    enabled?: boolean;
    refreshKey?: unknown;
    suspendAfterHook?: Promise<never>;
}>): React.ReactElement {
    const { state, install, refresh } = useDaemonVoiceModelCatalogState({
        client: React.useMemo(() => catalogClient(props.client), [props.client]),
        pollIntervalMs: 100,
        enabled: props.enabled,
        refreshKey: props.refreshKey,
    });
    if (props.suspendAfterHook) throw props.suspendAfterHook;
    const sttStatus = state.statuses.find((candidate) => candidate.packId === STT_PACK);
    return (
        <>
            {React.createElement('State', {
                installState: sttStatus?.installState ?? null,
                count: state.statuses.length,
                loading: state.loading,
                actionPackId: state.actionPackId,
                actionErrorPackId: state.actionError?.packId ?? null,
                actionErrorOperation: state.actionError?.operation ?? null,
            })}
            {React.createElement('InstallButton', { onPress: () => install(STT_PACK) })}
            {React.createElement('RefreshButton', { onPress: refresh })}
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

    it('keeps discovered external packs while making an uninstalled canonical pack actionable', async () => {
        const externalPackId = 'acme.speech/english-small';
        const canonicalEntry = listModelPackCatalogEntries()
            .find((entry) => entry.packId === STT_PACK)!;
        const listModels = vi.fn(async (): Promise<DaemonVoiceInferenceModelStatus[]> => [
            status(externalPackId, {
                pluginIdentity: { pluginId: 'acme.speech', packId: 'english-small' },
                kind: 'stt_sherpa',
                model: 'acme-english-small',
                runtimeFamily: 'sherpa_zipformer_streaming',
                runtimeSupported: true,
            }),
        ]);
        const getModelsStatus = vi.fn(
            async (_packIds?: readonly string[] | null): Promise<DaemonVoiceInferenceModelStatus[]> => [
                status(STT_PACK, {
                    runtimeFamily: canonicalEntry.runtimeFamily,
                    runtimeSupported: true,
                }),
            ],
        );
        const client = {
            listModels,
            getModelsStatus,
            installModel: vi.fn(async () => status(STT_PACK)),
            acceptModelPackLicense: vi.fn(async () => status(STT_PACK)),
            removeModel: vi.fn(async () => undefined),
        };

        function CatalogRefreshHarness(): React.ReactElement {
            const { state } = useDaemonVoiceModelCatalogState({ client });
            const rows = buildModelCatalogRows({
                statuses: state.statuses,
                selectedSttPackId: null,
                selectedTtsPackId: null,
            });
            const canonicalRow = rows.stt.find((row) => row.packId === STT_PACK);
            return React.createElement('CatalogRefreshState', {
                canonicalInstallState: canonicalRow?.state ?? null,
                canonicalCanInstall: canonicalRow?.canInstall ?? false,
                externalVisible: rows.stt.some((row) => row.packId === externalPackId),
            });
        }

        const { tree } = await renderScreen(<CatalogRefreshHarness />);
        await act(async () => {
            await Promise.resolve();
        });

        expect(listModels).toHaveBeenCalledWith();
        expect(getModelsStatus).toHaveBeenCalledWith(
            listModelPackCatalogEntries().map((entry) => entry.packId),
        );
        expect(tree.root.findByType('CatalogRefreshState').props).toMatchObject({
            canonicalInstallState: 'not_installed',
            canonicalCanInstall: true,
            externalVisible: true,
        });
    });

    it('echoes the exact tagged artifact binding from a license review to the daemon', async () => {
        const review = {
            pluginId: 'acme.speech',
            packId: 'english-small',
            pluginVersion: '1.2.3',
            packVersion: '2026.7.0',
            licenseId: 'acme-model-license-v1',
            licenseTitle: 'Acme model license',
            licenseText: 'Review these exact model terms.',
            licenseSourceUrl: 'https://example.test/licenses/acme-v1',
            licenseTextDigest: `sha256:${'a'.repeat(64)}`,
            artifactBinding: {
                kind: 'materialization' as const,
                immutableGenerationId: 'generation-local-1',
            },
            accepted: false,
        };
        const acceptModelPackLicense = vi.fn(async (
            _input: Parameters<DaemonVoiceInferenceClient['acceptModelPackLicense']>[0],
        ) => status(`${review.pluginId}/${review.packId}`));
        const client = {
            listModels: vi.fn(async () => []),
            getModelsStatus: vi.fn(async () => []),
            installModel: vi.fn(async () => status(STT_PACK)),
            acceptModelPackLicense,
            removeModel: vi.fn(async () => undefined),
        };

        function LicenseHarness(): React.ReactElement {
            const { acceptLicense } = useDaemonVoiceModelCatalogState({ client });
            return React.createElement('AcceptLicenseButton', {
                onPress: () => acceptLicense(review),
            });
        }

        const { tree } = await renderScreen(<LicenseHarness />);
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            await tree.root.findByType('AcceptLicenseButton').props.onPress();
        });

        const input = acceptModelPackLicense.mock.calls[0]?.[0];
        if (!input) throw new Error('Expected license acceptance input');
        expect(input).toEqual({
            qualifiedPackId: 'acme.speech/english-small',
            pluginId: review.pluginId,
            packId: review.packId,
            pluginVersion: review.pluginVersion,
            packVersion: review.packVersion,
            licenseId: review.licenseId,
            licenseSourceUrl: review.licenseSourceUrl,
            licenseTextDigest: review.licenseTextDigest,
            artifactBinding: review.artifactBinding,
        });
        expect(input.artifactBinding).toBe(review.artifactBinding);
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

    it('refreshes status when the selected execution-machine identity changes', async () => {
        const getModelsStatus = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([status(STT_PACK, { installState: 'installed' })]);
        const client = {
            getModelsStatus,
            installModel: vi.fn(async () => status(STT_PACK)),
            removeModel: vi.fn(async () => undefined),
        };

        const { tree } = await renderScreen(<TestHarness client={client} refreshKey="machine-a" />);
        await act(async () => { await Promise.resolve(); });
        expect(getModelsStatus).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree.update(<TestHarness client={client} refreshKey="machine-b" />);
            await Promise.resolve();
        });

        expect(getModelsStatus).toHaveBeenCalledTimes(2);
        const calls = getModelsStatus.mock.calls as unknown as ReadonlyArray<
            readonly [undefined, Readonly<{ machineId: string }>]
        >;
        expect(calls[0]?.[1]).toEqual({ machineId: 'machine-a' });
        expect(calls[1]?.[1]).toEqual({ machineId: 'machine-b' });
        expect(tree.root.findByType('State').props.installState).toBe('installed');
    });

    it('does not expose the previous machine status while the replacement machine refresh is pending', async () => {
        let resolveMachineB!: (value: DaemonVoiceInferenceModelStatus[]) => void;
        const machineBStatus = new Promise<DaemonVoiceInferenceModelStatus[]>((resolve) => {
            resolveMachineB = resolve;
        });
        const getModelsStatus = vi.fn()
            .mockResolvedValueOnce([status(STT_PACK, { installState: 'installed' })])
            .mockImplementationOnce(() => machineBStatus);
        const client = {
            getModelsStatus,
            installModel: vi.fn(async () => status(STT_PACK)),
            removeModel: vi.fn(async () => undefined),
        };

        const { tree } = await renderScreen(<TestHarness client={client} refreshKey="machine-a" />);
        await act(async () => { await Promise.resolve(); });
        expect(tree.root.findByType('State').props.installState).toBe('installed');

        await act(async () => {
            tree.update(<TestHarness client={client} refreshKey="machine-b" />);
            await Promise.resolve();
        });

        expect(getModelsStatus).toHaveBeenCalledTimes(2);
        expect(tree.root.findByType('State').props.installState).toBeNull();

        await act(async () => {
            resolveMachineB([status(STT_PACK, { installState: 'not_installed' })]);
            await machineBStatus;
        });
        expect(tree.root.findByType('State').props.installState).toBe('not_installed');
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
        const adaptedClient = catalogClient(client);

        function ErrorHarness(): React.ReactElement {
            const { state } = useDaemonVoiceModelCatalogState({ client: adaptedClient });
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
        const adaptedClient = catalogClient(client);

        function ErrorHarness(): React.ReactElement {
            const { state } = useDaemonVoiceModelCatalogState({ client: adaptedClient });
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

    it('does not let a stale status response overwrite a newer refresh', async () => {
        let resolveFirst!: (statuses: DaemonVoiceInferenceModelStatus[]) => void;
        const first = new Promise<DaemonVoiceInferenceModelStatus[]>((resolve) => {
            resolveFirst = resolve;
        });
        const getModelsStatus = vi.fn()
            .mockImplementationOnce(() => first)
            .mockResolvedValueOnce([status(STT_PACK, { installState: 'installed' })]);
        const client = {
            getModelsStatus,
            installModel: vi.fn(async () => status(STT_PACK)),
            removeModel: vi.fn(async () => undefined),
        };

        const { tree } = await renderScreen(<TestHarness client={client} />);
        await pressTestInstanceAsync(tree.root.findByType('RefreshButton'));
        expect(tree.root.findByType('State').props.installState).toBe('installed');

        await act(async () => {
            resolveFirst([status(STT_PACK, { installState: 'not_installed' })]);
            await first;
        });
        expect(tree.root.findByType('State').props.installState).toBe('installed');
    });

    it('keeps known catalog rows stable while a background refresh is pending', async () => {
        let resolveRefresh!: (statuses: DaemonVoiceInferenceModelStatus[]) => void;
        const pendingRefresh = new Promise<DaemonVoiceInferenceModelStatus[]>((resolve) => {
            resolveRefresh = resolve;
        });
        const getModelsStatus = vi.fn()
            .mockResolvedValueOnce([status(STT_PACK, { installState: 'installed' })])
            .mockImplementationOnce(() => pendingRefresh);
        const client = {
            getModelsStatus,
            installModel: vi.fn(async () => status(STT_PACK)),
            removeModel: vi.fn(async () => undefined),
        };
        const { tree } = await renderScreen(<TestHarness client={client} />);
        await act(async () => { await Promise.resolve(); });

        let refresh!: Promise<void>;
        await act(async () => {
            refresh = tree.root.findByType('RefreshButton').props.onPress();
            await Promise.resolve();
        });

        expect(tree.root.findByType('State').props).toMatchObject({
            installState: 'installed',
            loading: false,
        });

        await act(async () => {
            resolveRefresh([status(STT_PACK, { installState: 'installed' })]);
            await refresh;
        });
    });

    it('rejects a second model mutation while the current action is still in flight', async () => {
        let resolveInstall!: (value: DaemonVoiceInferenceModelStatus) => void;
        const pendingInstall = new Promise<DaemonVoiceInferenceModelStatus>((resolve) => {
            resolveInstall = resolve;
        });
        const client = {
            getModelsStatus: vi.fn(async () => [status(STT_PACK)]),
            installModel: vi.fn(() => pendingInstall),
            removeModel: vi.fn(async () => undefined),
        };
        const { tree } = await renderScreen(<TestHarness client={client} />);
        await act(async () => { await Promise.resolve(); });

        let firstAction!: Promise<void>;
        await act(async () => {
            firstAction = tree.root.findByType('InstallButton').props.onPress();
            tree.root.findByType('InstallButton').props.onPress();
            await Promise.resolve();
        });
        expect(client.installModel).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolveInstall(status(STT_PACK, { installState: 'installed' }));
            await firstAction;
        });
    });

    it('owns the catalog mutation while an install prerequisite is being reviewed', async () => {
        let finishReview!: (accepted: boolean) => void;
        const review = new Promise<boolean>((resolve) => {
            finishReview = resolve;
        });
        const client = {
            getModelsStatus: vi.fn(async () => [status(STT_PACK)]),
            installModel: vi.fn(async () => status(STT_PACK, { installState: 'installed' })),
            removeModel: vi.fn(async () => undefined),
        };

        function ReviewHarness(): React.ReactElement {
            const { state, install, remove } = useDaemonVoiceModelCatalogState({
                client: React.useMemo(() => catalogClient(client), []),
            });
            return React.createElement('ReviewState', {
                actionPackId: state.actionPackId,
                start: () => install(STT_PACK, () => review),
                competing: () => remove(STT_PACK),
            });
        }

        const { tree } = await renderScreen(<ReviewHarness />);
        await act(async () => { await Promise.resolve(); });
        const owner = tree.root.findByType('ReviewState');
        let installResult!: Promise<void>;
        await act(async () => {
            installResult = owner.props.start();
            await Promise.resolve();
        });
        expect(tree.root.findByType('ReviewState').props.actionPackId).toBe(STT_PACK);

        await act(async () => {
            await tree.root.findByType('ReviewState').props.competing();
        });
        expect(client.removeModel).not.toHaveBeenCalled();

        await act(async () => {
            finishReview(false);
            await installResult;
        });
        expect(client.installModel).not.toHaveBeenCalled();
        expect(tree.root.findByType('ReviewState').props.actionPackId).toBeNull();
    });

    it('does not accept or install through a stale license review after machine replacement', async () => {
        let finishReview!: (accepted: boolean) => void;
        const reviewDecision = new Promise<boolean>((resolve) => {
            finishReview = resolve;
        });
        const review = {
            pluginId: 'acme.speech',
            packId: 'english-small',
            pluginVersion: '1.2.3',
            packVersion: '2026.7.0',
            licenseId: 'acme-model-license-v1',
            licenseTitle: 'Acme model license',
            licenseText: 'Review these exact model terms.',
            licenseSourceUrl: 'https://example.test/licenses/acme-v1',
            licenseTextDigest: `sha256:${'a'.repeat(64)}`,
            artifactBinding: {
                kind: 'materialization' as const,
                immutableGenerationId: 'generation-local-1',
            },
            accepted: false,
        };
        const acceptModelPackLicense = vi.fn(async () => status(STT_PACK));
        const installModel = vi.fn(async () => status(STT_PACK, { installState: 'installed' }));
        const client = {
            listModels: vi.fn(async (scope?: DaemonVoiceInferenceModelMachineScope) => [
                status(STT_PACK, {
                    installState: scope?.machineId === 'machine-b' ? 'installed' : 'not_installed',
                }),
            ]),
            getModelsStatus: vi.fn(async () => []),
            installModel,
            acceptModelPackLicense,
            removeModel: vi.fn(async () => undefined),
        };

        function ScopeReviewHarness(props: Readonly<{ machineId: string }>): React.ReactElement {
            const controller = useDaemonVoiceModelCatalogState({
                client,
                refreshKey: props.machineId,
            });
            const current = controller.state.statuses.find((candidate) => candidate.packId === STT_PACK);
            return React.createElement('ScopeReviewState', {
                installState: current?.installState ?? null,
                start: () => controller.install(STT_PACK, async (isCurrent) => {
                    const accepted = await reviewDecision;
                    if (!accepted || !isCurrent()) return false;
                    await controller.acceptLicense(review);
                    return isCurrent();
                }),
            });
        }

        const { tree } = await renderScreen(<ScopeReviewHarness machineId="machine-a" />);
        await act(async () => { await Promise.resolve(); });
        let staleInstall!: Promise<void>;
        await act(async () => {
            staleInstall = tree.root.findByType('ScopeReviewState').props.start();
            await Promise.resolve();
        });

        await act(async () => {
            tree.update(<ScopeReviewHarness machineId="machine-b" />);
            await Promise.resolve();
        });
        expect(tree.root.findByType('ScopeReviewState').props.installState).toBe('installed');

        await act(async () => {
            finishReview(true);
            await staleInstall;
        });
        expect(acceptModelPackLicense).not.toHaveBeenCalled();
        expect(installModel).not.toHaveBeenCalled();
        expect(tree.root.findByType('ScopeReviewState').props.installState).toBe('installed');
    });

    it('settles a completed mutation without waiting for a slow status refresh', async () => {
        let resolveRefresh!: (value: DaemonVoiceInferenceModelStatus[]) => void;
        const pendingRefresh = new Promise<DaemonVoiceInferenceModelStatus[]>((resolve) => {
            resolveRefresh = resolve;
        });
        const client = {
            getModelsStatus: vi.fn()
                .mockResolvedValueOnce([status(STT_PACK)])
                .mockImplementationOnce(() => pendingRefresh),
            installModel: vi.fn(async () => {
                throw Object.assign(new Error('manifest unavailable'), { code: 'internal_error' });
            }),
            removeModel: vi.fn(async () => undefined),
        };
        const { tree } = await renderScreen(<TestHarness client={client} />);
        await act(async () => { await Promise.resolve(); });

        let action!: Promise<void>;
        await act(async () => {
            action = tree.root.findByType('InstallButton').props.onPress() as Promise<void>;
            await Promise.resolve();
        });
        let settled = false;
        void action.then(() => { settled = true; });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(settled).toBe(true);
        expect(tree.root.findByType('State').props.actionPackId).toBeNull();
        expect(tree.root.findByType('State').props.actionErrorPackId).toBe(STT_PACK);
        expect(tree.root.findByType('State').props.actionErrorOperation).toBe('install');
        expect(client.getModelsStatus).toHaveBeenCalledTimes(2);

        await act(async () => {
            resolveRefresh([status(STT_PACK)]);
            await pendingRefresh;
        });
        expect(tree.root.findByType('State').props.actionErrorPackId).toBe(STT_PACK);
    });

    it('clears a retained install failure when authoritative status later reports installed', async () => {
        let resolveRefresh!: (value: DaemonVoiceInferenceModelStatus[]) => void;
        const pendingRefresh = new Promise<DaemonVoiceInferenceModelStatus[]>((resolve) => {
            resolveRefresh = resolve;
        });
        const client = {
            getModelsStatus: vi.fn()
                .mockResolvedValueOnce([status(STT_PACK)])
                .mockImplementationOnce(() => pendingRefresh),
            installModel: vi.fn(async () => {
                throw Object.assign(new Error('response lost'), { code: 'request_timeout' });
            }),
            removeModel: vi.fn(async () => undefined),
        };
        const { tree } = await renderScreen(<TestHarness client={client} />);
        await act(async () => { await Promise.resolve(); });

        await act(async () => {
            void tree.root.findByType('InstallButton').props.onPress();
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(tree.root.findByType('State').props.actionErrorPackId).toBe(STT_PACK);

        await act(async () => {
            resolveRefresh([status(STT_PACK, { installState: 'installed' })]);
            await pendingRefresh;
        });
        expect(tree.root.findByType('State').props.actionErrorPackId).toBeNull();
    });

    it('ignores a late mutation result from a previously selected execution machine', async () => {
        let rejectInstall!: (error: Error) => void;
        const pendingInstall = new Promise<DaemonVoiceInferenceModelStatus>((_resolve, reject) => {
            rejectInstall = reject;
        });
        const client = {
            getModelsStatus: vi.fn(async () => [status(STT_PACK)]),
            installModel: vi.fn(() => pendingInstall),
            removeModel: vi.fn(async () => undefined),
        };
        const { tree } = await renderScreen(<TestHarness client={client} refreshKey="machine-a" />);
        await act(async () => { await Promise.resolve(); });

        let action!: Promise<void>;
        await act(async () => {
            action = tree.root.findByType('InstallButton').props.onPress();
            await Promise.resolve();
        });
        expect(tree.root.findByType('State').props.actionPackId).toBe(STT_PACK);

        await act(async () => {
            tree.update(<TestHarness client={client} refreshKey="machine-b" />);
            await Promise.resolve();
        });
        expect(tree.root.findByType('State').props.actionPackId).toBeNull();

        await act(async () => {
            rejectInstall(Object.assign(new Error('old machine failed'), { code: 'internal_error' }));
            await action;
        });

        expect(tree.root.findByType('State').props.actionErrorPackId).toBeNull();
        expect(client.getModelsStatus).toHaveBeenCalledTimes(2);
    });

    it('does not refresh daemon status after an in-flight action is disabled', async () => {
        let resolveInstall!: (value: DaemonVoiceInferenceModelStatus) => void;
        const pendingInstall = new Promise<DaemonVoiceInferenceModelStatus>((resolve) => {
            resolveInstall = resolve;
        });
        const client = {
            getModelsStatus: vi.fn(async () => [status(STT_PACK)]),
            installModel: vi.fn(() => pendingInstall),
            removeModel: vi.fn(async () => undefined),
        };
        const { tree } = await renderScreen(<TestHarness client={client} enabled />);
        await act(async () => { await Promise.resolve(); });

        let action!: Promise<void>;
        await act(async () => {
            action = tree.root.findByType('InstallButton').props.onPress();
            await Promise.resolve();
        });
        await act(async () => {
            tree.update(<TestHarness client={client} enabled={false} />);
            await Promise.resolve();
        });
        await act(async () => {
            resolveInstall(status(STT_PACK, { installState: 'installed' }));
            await action;
        });

        expect(client.getModelsStatus).toHaveBeenCalledTimes(1);
        expect(tree.root.findByType('State').props.actionPackId).toBeNull();
    });

    it('does not refresh daemon status after an in-flight action owner unmounts', async () => {
        let resolveInstall!: (value: DaemonVoiceInferenceModelStatus) => void;
        const pendingInstall = new Promise<DaemonVoiceInferenceModelStatus>((resolve) => {
            resolveInstall = resolve;
        });
        const client = {
            getModelsStatus: vi.fn(async () => [status(STT_PACK)]),
            installModel: vi.fn(() => pendingInstall),
            removeModel: vi.fn(async () => undefined),
        };
        const { tree } = await renderScreen(<TestHarness client={client} enabled />);
        await act(async () => { await Promise.resolve(); });

        let action!: Promise<void>;
        await act(async () => {
            action = tree.root.findByType('InstallButton').props.onPress();
            await Promise.resolve();
        });
        await act(async () => {
            tree.unmount();
            await Promise.resolve();
        });
        await act(async () => {
            resolveInstall(status(STT_PACK, { installState: 'installed' }));
            await action;
        });

        expect(client.getModelsStatus).toHaveBeenCalledTimes(1);
    });

    it('does not invalidate a committed action from a suspended replacement render that never commits', async () => {
        let resolveInstall!: (value: DaemonVoiceInferenceModelStatus) => void;
        const pendingInstall = new Promise<DaemonVoiceInferenceModelStatus>((resolve) => {
            resolveInstall = resolve;
        });
        const neverCommits = new Promise<never>(() => undefined);
        const client = {
            getModelsStatus: vi.fn(async () => [status(STT_PACK)]),
            installModel: vi.fn(() => pendingInstall),
            removeModel: vi.fn(async () => undefined),
        };
        const { tree } = await renderScreen(
            <React.Suspense fallback={React.createElement('Fallback')}>
                <TestHarness client={client} refreshKey="machine-a" />
            </React.Suspense>,
        );
        await act(async () => { await Promise.resolve(); });

        let action!: Promise<void>;
        await act(async () => {
            action = tree.root.findByType('InstallButton').props.onPress();
            await Promise.resolve();
        });
        await act(async () => {
            tree.update(
                <React.Suspense fallback={React.createElement('Fallback')}>
                    <TestHarness
                        client={client}
                        refreshKey="machine-b"
                        suspendAfterHook={neverCommits}
                    />
                </React.Suspense>,
            );
            await Promise.resolve();
        });

        await act(async () => {
            resolveInstall(status(STT_PACK, { installState: 'installed' }));
            await action;
        });

        expect(client.getModelsStatus).toHaveBeenCalledTimes(2);
    });

    it('does not disable a committed action from a suspended disabled render that never commits', async () => {
        let resolveInstall!: (value: DaemonVoiceInferenceModelStatus) => void;
        const pendingInstall = new Promise<DaemonVoiceInferenceModelStatus>((resolve) => {
            resolveInstall = resolve;
        });
        const neverCommits = new Promise<never>(() => undefined);
        const client = {
            getModelsStatus: vi.fn(async () => [status(STT_PACK)]),
            installModel: vi.fn(() => pendingInstall),
            removeModel: vi.fn(async () => undefined),
        };
        const { tree } = await renderScreen(
            <React.Suspense fallback={React.createElement('Fallback')}>
                <TestHarness client={client} refreshKey="machine-a" enabled />
            </React.Suspense>,
        );
        await act(async () => { await Promise.resolve(); });

        let action!: Promise<void>;
        await act(async () => {
            action = tree.root.findByType('InstallButton').props.onPress();
            await Promise.resolve();
        });
        await act(async () => {
            tree.update(
                <React.Suspense fallback={React.createElement('Fallback')}>
                    <TestHarness
                        client={client}
                        refreshKey="machine-a"
                        enabled={false}
                        suspendAfterHook={neverCommits}
                    />
                </React.Suspense>,
            );
            await Promise.resolve();
        });

        await act(async () => {
            resolveInstall(status(STT_PACK, { installState: 'installed' }));
            await action;
        });

        expect(client.getModelsStatus).toHaveBeenCalledTimes(2);
    });
});
