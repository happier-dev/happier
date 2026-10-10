import * as React from 'react';
import NodeModule from 'node:module';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { HappierInputField, HappierSelect, type HappierInputPickerPort } from '@happier-dev/plugin-ui/presentation';
import type { WorkflowInputDefinition } from '@happier-dev/protocol/workflows/workflowV1';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import type { FetchedMachineRow } from '@/sync/engine/machines/syncMachines';
import { renderScreen, findAllHostTestInstances, pressTestInstanceAsync } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const rpc = vi.hoisted(() => ({ machine: vi.fn(), cancel: vi.fn() }));
const nativeBoundary = vi.hoisted(() => ({ context: undefined as RenderContext | undefined }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());
// The platform executable-loader boundary supplies the real public author module.
// Projection admission, the modal, native mount and Host API settlement remain real.
vi.mock('@/components/plugins/reactNative/resolveDefaultReactNativeLoaderBackend', () => {
    const backend = { backendId: 'commonJs', available: true,
        loadInstalledBundle: async () => (context: RenderContext) => {
            nativeBoundary.context = context;
            return renderPublicPicker(context);
        } };
    return { resolveDefaultReactNativeLoaderBackend: () => backend };
});
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));
// The native Markdown package's unpublished web entry is unavailable on this host; this test never renders Markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Leave scoped RPC, Account admission and codecs real; replace Socket.IO's remote ACK only.
installDisconnectedServerSocketBoundary((socket) => {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
        if (event !== 'rpc-call') throw new Error(`Unexpected workflow socket event: ${event}`);
        // Manager URI and auth are Socket.IO's external transport configuration.
        const carrier = socket as unknown as { io: { uri: string }; auth: { token?: string } };
        expect(new URL(carrier.io.uri).origin).toBe('https://inputs.example');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        expect(carrier.auth.token).toBe((await TokenStorage.getCredentialsForServerUrl('https://inputs.example'))?.token);
        // Socket.IO has a generic payload; immediately narrow to its published wire request.
        const request = payload as SocketRpcRequestPayload;
        return { ok: true, result: await rpc.machine(request) };
    });
    vi.spyOn(socket, 'emit').mockImplementation((event, ...args) => {
        if (event === 'rpc-cancel') rpc.cancel(args[0]);
        // Non-ACK presence/subscription packets also stop at this network boundary.
        return socket;
    });
    vi.spyOn(socket, 'disconnect').mockImplementation(() => {
        socket.connected = false;
        for (const listener of socket.listeners('disconnect')) listener('io client disconnect');
        return socket;
    });
});
// Compile the real native owner and public author at collection, not while an interaction is pending.
const { renderSurface: renderPublicPicker } = await import('../../../../../../packages/plugin-sdk/examples/public-authoring/ui/reviewPanel.native');
const { PluginSurfaceHost } = await import('@/components/plugins/surfaces/PluginSurfaceHost');
const { storage } = await import('@/sync/domains/state/storage');
const defaultExecutorModule = await import('@/sync/ops/actions/defaultActionExecutor');
const { WorkflowRunComposer } = await import('./WorkflowRunComposer');
const { AgentInput } = await import('@/components/sessions/agentInput');
const { useInputFieldOptions } = await import('@/components/sessions/actions/useInputFieldOptions');

const inputs: readonly WorkflowInputDefinition[] = [
    { name: 'channels', valueType: 'json', required: true, optionsSourceId: 'notifications.channels.available' },
    { name: 'channel', valueType: 'string', required: true, optionsSourceId: 'notifications.channels.available' },
];
const reply = { actionId: null, fieldPath: null, optionsSourceId: 'notifications.channels.available',
    options: [{ value: 'push', label: 'Phone' }] };

function publishMachine(serverId: string, machine: ReturnType<typeof createMachineFixture>): void {
    const row = {
        ...machine,
        metadata: encodePlainMachineStoredContent(machine.metadata),
        daemonState: machine.daemonState === null ? null : encodePlainMachineStoredContent(machine.daemonState),
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    } satisfies FetchedMachineRow;
    harness.answer(serverId, `GET /v1/machines/${machine.id}`, { body: { machine: row } });
    harness.answer(serverId, 'GET /v1/machines', { body: [row] });
}

/** Presses the picker control and lets the host's asynchronous settlement land. */
async function choose(control: Parameters<typeof pressTestInstanceAsync>[0]): Promise<void> {
    await pressTestInstanceAsync(control, 'picker');
    const { act } = await import('react-test-renderer');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('Workflow inputs through real Action option resolution', () => {
    // Metro's lazy require is a module-loader boundary. Return the real module from the Vitest graph
    // so the bundled require cannot bypass this run's native/network boundaries. No Action logic is replaced.
    const loader = NodeModule as unknown as {
        _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown;
    };
    const load = loader._load;
    let restoreLoader: (() => void) | undefined;
    beforeEach(async () => {
        await loadSyncSingletonForTests();
        await harness.reset(); rpc.machine.mockReset(); rpc.cancel.mockReset();
        // Account connection disposal restores its credential spy. Reinstall the
        // enclosing Home boundaries so the next case still has its own credentials.
        installHomeGovernanceBoundaries(harness);
        nativeBoundary.context = undefined;
        const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        clearDaemonMergedProjectionCacheForTests();
        const spy = vi.spyOn(loader, '_load').mockImplementation((request, parent, isMain) =>
            request === './defaultActionExecutor' && parent?.filename?.endsWith('/frontDoorRuntimeActionExecutor.ts')
                ? defaultExecutorModule : load.call(loader, request, parent, isMain));
        restoreLoader = () => spy.mockRestore();
    });
    afterEach(() => { standardCleanup(); restoreLoader?.(); });

    async function connectHome() {
        const serverId = await harness.addHome({ name: 'Input Home', serverUrl: 'https://inputs.example', accountId: 'account-a' });
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://inputs.example', accountId: 'account-a',
            request: async (url, init) => {
                const { serverFetch } = await import('@/sync/http/client');
                const requestUrl = new URL(String(url));
                return serverFetch(`${requestUrl.pathname}${requestUrl.search}`, init);
            } });
        onTestFinished(() => connection.dispose());
        await waitForHomeGovernance(() => expect(storage.getState().endpointStatus).toBe('online'));
        return serverId;
    }

    async function mount() {
        const serverId = await connectHome();
        const machine = createMachineFixture({ id: 'input-relay', storageMode: 'plain', activeAt: Date.now() });
        publishMachine(serverId, machine);
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
        const composer = await renderScreen(<WorkflowRunComposer inputs={inputs} values={{}}
            serverId={serverId} onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} />);
        return { composer, serverId };
    }

    it('uses the current Action front door for the loaded input lifetime', async () => {
        rpc.machine.mockResolvedValue(reply);
        const { serverId } = await mount();
        const { callWorkflowAction } = await import('@/sync/domains/workflows/callWorkflowAction');
        await expect(callWorkflowAction({ actionId: 'action.options.resolve',
            input: { optionsSourceId: 'notifications.channels.available' }, context: { serverId },
            parseResult: (value) => value })).resolves.toEqual(reply);
    });

    it('keeps a UI-disabled registered draft unavailable and exposes its source failure with retry', async () => {
        rpc.machine.mockResolvedValue(reply);
        const { serverId } = await mount();
        const { SessionActionDraftCard } = await import('@/components/sessions/actions/SessionActionDraftCard');
        const session = createSessionFixture({ id: 'session-1', serverId,
            metadata: { machineId: 'input-relay', path: '/repo', host: 'inputs' } });
        const draft = {
            id: 'd1', address: { serverId, sessionId: 'session-1' }, accountId: 'account-a',
            actionId: 'notifications.notify_me', createdAt: 1, status: 'editing' as const,
            input: { message: 'Finished', channels: [] },
        };
        storage.setState({ sessions: { [session.id]: session },
            sessionActionDraftsByAddressKey: { [JSON.stringify([serverId, 'session-1'])]: [draft] } });
        const { useSessionActionFieldOptions } = await import('@/components/sessions/actions/useSessionActionFieldOptions');
        const options = await renderHook(() => useSessionActionFieldOptions('session-1', serverId));
        const card = await renderScreen(<SessionActionDraftCard draft={draft} />);
        await flushHookEffects();
        const { getActionSpec } = await import('@happier-dev/protocol');
        const field = getActionSpec('notifications.notify_me').inputHints!.fields!.find(field => field.path === 'channels')!;
        expect(options.getCurrent().state?.(field)).toEqual({ status: 'failed', options: [], errorCode: 'action_disabled' });
        const { SurfaceStateCard } = await import('@/components/ui/surfaces');
        const failure = card.findByType(SurfaceStateCard);
        expect(failure.props.diagnosticCode).toBe('action_disabled');
        expect(failure.props.action?.onPress).toEqual(expect.any(Function));
        expect(card.findByType(HappierSelect)!.props.disabled).toBe(true);
        const { resolveSessionActionDraftHeightBearingPaint } = await import('@/components/sessions/actions/sessionActionDraftPresentation');
        const paint = resolveSessionActionDraftHeightBearingPaint({ draft, sessionId: 'session-1', resolveFieldOptions: options.getCurrent() });
        expect(paint.fields.find(entry => entry.field.path === 'channels')?.options).toEqual([{ label: 'common.error' }]);
    });

    it('keeps every dynamic field in Inputs, reads only on opening, and requires explicit choices', async () => {
        rpc.machine.mockResolvedValue(reply);
        const { composer, serverId } = await mount();
        expect(rpc.machine).not.toHaveBeenCalled();
        expect(composer.findByTestId('workflow-run-inputs-run')!.props.disabled).toBe(true);
        const chip = composer.findByType(AgentInput).props.extraActionChips.find((entry: { controlId?: string }) => entry.controlId === 'workflowInputs');
        const panel = await renderScreen(chip.collapsedContentPopover.renderContent);
        expect(panel.findAllByType(HappierSelect)).toHaveLength(2);
        expect(panel.findAllByType(HappierSelect).map((select) => select.props.options)).toEqual([reply.options, reply.options]);
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({
            method: 'input-relay:action.options.resolve',
            params: { actionId: 'notifications.notify_me', fieldPath: 'channels' },
        }));
        // Discovery must not choose a channel or make a required/no-default Run runnable.
        expect(composer.findByTestId('workflow-run-inputs-run')!.props.disabled).toBe(true);
    });

    it('shows a refused source instead of empty ready choices and offers retry', async () => {
        rpc.machine.mockResolvedValue({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });
        const { composer } = await mount();
        const chip = composer.findByType(AgentInput).props.extraActionChips.find((entry: { controlId?: string }) => entry.controlId === 'workflowInputs');
        const panel = await renderScreen(chip.collapsedContentPopover.renderContent);
        const { SurfaceStateCard } = await import('@/components/ui/surfaces');
        expect(panel.findAllByType(HappierSelect).every((select) => select.props.disabled)).toBe(true);
        const error = panel.findAllByType(SurfaceStateCard)[0]!;
        expect(error.props.diagnosticCode).toBe('target_unavailable');
        rpc.machine.mockResolvedValue(reply);
        const { act } = await import('react-test-renderer');
        await act(async () => { error.props.action.onPress(); });
        expect(panel.findAllByType(HappierSelect)[0]!.props.options).toEqual(reply.options);
    });

    it.each([false, true])('offers a typed input’s declared picker with descriptor-scoped options (picker-only=%s)', async (pickerOnly) => {
        const { repositoryInputTypeRef, repositoryInputTypes } = await import('../../../../../../packages/plugin-sdk/examples/public-authoring/inputTypes');
        const typed: readonly WorkflowInputDefinition[] = [{ name: 'repository', valueType: 'json', required: true, inputType: repositoryInputTypeRef }];
        const review = { repositoryId: 'example/review-assistant' };
        const workflow = `plugin:${repositoryInputTypeRef.pluginId}/review`;
        const workflowDefinition = { version: 1, inputs: typed, defaults: {}, blocks: [{ kind: 'wait', id: 'review',
            document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }] };
        const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
        const { PluginProjectionV2Schema, DaemonPluginUiArtifactBytesReadResponseSchema } = await import('@happier-dev/protocol');
        const { computePluginUiArtifactSha256DigestV1, computePluginUiArtifactFileSetSha256DigestV1 } = await import('@happier-dev/protocol/plugins/ui');
        const { encodeBase64 } = await import('@/encryption/base64');
        const nativeBytes = new TextEncoder().encode('exports.renderSurface = function () { return null; };');
        const nativeEntry = 'react-native/review-picker/entry.cjs.bundle';
        const nativeIdentity = { pluginId: repositoryInputTypeRef.pluginId, contributionId: 'review-native',
            artifactId: 'review-picker', artifactDigest: computePluginUiArtifactFileSetSha256DigestV1([
                { relativePath: nativeEntry, bytes: nativeBytes },
            ]), platform: 'web' as const };
        const nativeGraph = { artifactId: nativeIdentity.artifactId, tier: 'reactNative',
            entry: nativeEntry, files: [{ relativePath: nativeEntry,
                digest: computePluginUiArtifactSha256DigestV1(nativeBytes), byteSize: nativeBytes.length }], digest: nativeIdentity.artifactDigest,
            builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0' };
        const { options: _declaredChoices, ...pickerOnlyDefinition } = repositoryInputTypes.repository;
        const projectedType = { id: 'repository', ...(pickerOnly ? pickerOnlyDefinition : repositoryInputTypes.repository) };
        const pickerProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
                installedPackagesById: { [repositoryInputTypeRef.pluginId]: {
                    id: repositoryInputTypeRef.pluginId, displayName: 'Review assistant', version: '1.0.0', enabled: true,
                    occurrenceId: 'occurrence-1', source: { kind: 'bundled', locator: repositoryInputTypeRef.pluginId },
                } }, familiesById: {
                inputTypes: { family: 'inputTypes', entriesById: { [`${repositoryInputTypeRef.pluginId}/repository`]: {
                    id: `${repositoryInputTypeRef.pluginId}/repository`, pluginId: repositoryInputTypeRef.pluginId,
                    pluginVersion: '1.0.0', occurrenceId: 'occurrence-1', definition: projectedType,
                    pickerSurface: {
                        contribution: repositoryInputTypeRef, occurrenceId: 'occurrence-1', projectionGeneration: 1,
                        rendererChain: [{ pluginId: repositoryInputTypeRef.pluginId, localId: 'review-native' }],
                        selectedRenderer: { identity: { pluginId: repositoryInputTypeRef.pluginId, localId: 'review-native' },
                            renderer: { kind: 'reactNative', contributionId: 'review-native' },
                            artifactProjection: { id: `reactNativeBundle:${repositoryInputTypeRef.pluginId}:review-native`,
                                pluginId: repositoryInputTypeRef.pluginId, occurrenceId: 'occurrence-1',
                                contributionKind: 'reactNativeBundle', contributionId: 'review-native', generatedV2: true,
                                artifactSelectionOwner: 'daemonProjection',
                                pluginVersion: '1.0.0', artifactGraph: nativeGraph,
                                hostApi: { minVersion: '1.0.0', methods: ['context', 'settleEphemeralInput'] },
                                runtime: { decision: { state: 'load', reason: 'compatible', diagnostics: [] },
                                    loadPolicy: { source: 'installedArtifact' }, cacheKey: 'review-picker-native',
                                    cacheIdentity: { artifactDigest: nativeIdentity.artifactDigest } } },
                            availability: { state: 'available', reason: 'available', diagnostics: [] } },
                        executionOrigin: { serverIdentityId: 'srv_inputs', materializationRef: {
                            machineId: 'input-relay', materializationId: 'review-current', pluginId: repositoryInputTypeRef.pluginId } },
                        resourceCapability: { readable: true, dynamic: true },
                        contributorTargetedContributions: { target: { pluginId: repositoryInputTypeRef.pluginId,
                            occurrenceId: 'occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'review-root' } }, points: [] },
                    },
                } } },
                workflows: { family: 'workflows', entriesById: { [`${repositoryInputTypeRef.pluginId}/review`]: {
                    id: `${repositoryInputTypeRef.pluginId}/review`, pluginId: repositoryInputTypeRef.pluginId, pluginVersion: '1.0.0',
                    definition: { id: 'review', title: 'Review', definition: workflowDefinition },
                } } },
            } });
        const nativeByteReply = DaemonPluginUiArtifactBytesReadResponseSchema.parse({
            ok: true, artifactFamily: 'reactNative', cacheIdentity: { artifactDigest: nativeIdentity.artifactDigest },
            artifact: { artifactKind: 'reactNativeBundle', digest: nativeIdentity.artifactDigest,
                format: 'plainJs', byteSize: nativeBytes.length },
            files: [{ ...nativeGraph.files[0]!, bytesBase64: encodeBase64(nativeBytes) }],
        });
        rpc.machine.mockImplementation(async (request) => request.method === `input-relay:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`
            ? { protocolVersion: 1, projection: pickerProjection }
            : request.method === `input-relay:${RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ}`
                ? nativeByteReply
            : { actionId: 'workflow.run.start', fieldPath: 'repository',
                optionsSourceId: pickerOnly ? null : `plugin-input:${repositoryInputTypeRef.pluginId}/repository`,
                options: pickerOnly ? [] : [{ value: review, label: 'Review assistant' }] });
        const serverId = await connectHome();
        const machine = createMachineFixture({ id: 'input-relay', storageMode: 'plain', activeAt: Date.now() });
        publishMachine(serverId, machine);
        harness.answer(serverId, 'GET /v1/artifacts?limit=500&includeBody=true', { body: [] });
        const { PluginAvailabilityActionHttpPathsV1 } = await import('@happier-dev/protocol/plugins/availability');
        harness.answer(serverId, `POST ${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']}`,
            { body: { availabilityCursor: 1, snapshots: [] } });
        harness.answer(serverId, `POST ${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']}`,
            { body: { availabilityCursor: 1, pluginIds: [] } });
        // Load the Account projection through its real HTTP hydrator. The daemon's
        // admitted occurrence selects this local artifact, not a fabricated Account release.
        const { createActivePluginAccountAvailabilityProjectionHydrator } = await import('@/sync/api/plugins/availability/pluginAvailabilityProjection');
        const { applyPluginAccountAvailabilityProjectionRefresh } = await import('@/sync/domains/plugins/availability/projection');
        const availability = await createActivePluginAccountAvailabilityProjectionHydrator().refresh();
        expect(availability).not.toBeNull();
        applyPluginAccountAvailabilityProjectionRefresh(availability!);
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
        const onChangeValues = vi.fn();
        const composer = await renderScreen(<WorkflowRunComposer inputs={typed} values={{}}
            optionsConsumer={{ kind: 'workflow', workflow }}
            serverId={serverId} onChangeValues={onChangeValues} onRun={() => {}} onCancel={() => {}} />);
        // A typed input is a choice, never the main free-text input.
        expect(composer.findByTestId('workflow-run-inputs-preview')).toBeTruthy();
        const chip = composer.findByType(AgentInput).props.extraActionChips.find((entry: { controlId?: string }) => entry.controlId === 'workflowInputs');
        const { ModalProvider } = await import('@/modal');
        const productionPanel = await renderScreen(<ModalProvider>{chip.collapsedContentPopover.renderContent}</ModalProvider>);
        await flushHookEffects();
        await waitForHomeGovernance(() => {
            expect(productionPanel.findByType(HappierInputField).props.optionsStatus).toBe('ready');
            expect(productionPanel.findHostByTestId('workflow-run-inputs-repository-picker')?.props.disabled).toBe(false);
        });
        const productionBrowse = productionPanel.findHostByTestId('workflow-run-inputs-repository-picker');
        const { HappierInputPickerProvider } = await import('@happier-dev/plugin-ui/presentation');
        const pickerPort: HappierInputPickerPort | null = productionPanel.findByType(HappierInputPickerProvider).props.port;
        if (!pickerPort) throw new Error('Expected the production input-picker port');
        const pickerAttempt = vi.spyOn(pickerPort, 'pick');
        const { act } = await import('react-test-renderer');
        // Opening returns the terminal settlement promise. Do not await that before
        // the person can interact with the mounted modal.
        await act(async () => {
            productionBrowse!.props.onPress();
        });
        await Promise.race([
            waitForHomeGovernance(() => {
                expect(nativeBoundary.context).toBeDefined();
            }),
            pickerAttempt.mock.results[0]!.value.then((result: unknown) => {
                throw new Error(`Picker settled before native mount: ${JSON.stringify(result)}; aborted=${pickerAttempt.mock.calls[0]![0].signal.aborted}`);
            }),
        ]);
        expect(nativeBoundary.context?.launchInput).toEqual({ inputType: repositoryInputTypeRef, semantic: 'repository',
            ...(pickerOnly ? {} : { options: [{ value: review, label: 'Review assistant' }] }) });
        const pickerContext = nativeBoundary.context!;
        const nativeChoice = pickerOnly ? 'Cancel' : 'Review assistant';
        const nativeControl = () => findAllHostTestInstances(productionPanel.findByType(PluginSurfaceHost), node =>
            (node.props.accessibilityLabel ?? node.props['aria-label']) === nativeChoice
                && (typeof node.props.onPress === 'function' || typeof node.props.onClick === 'function')).at(-1);
        await waitForHomeGovernance(() => expect(nativeControl()).toBeDefined());
        expect(nativeControl()?.props.disabled).not.toBe(true);
        expect(nativeBoundary.context?.signal.aborted).toBe(false);
        await choose(nativeControl());
        expect(productionPanel.findAllByType(PluginSurfaceHost)).toHaveLength(0);
        if (pickerOnly) expect(onChangeValues).not.toHaveBeenCalled();
        else await waitForHomeGovernance(() => expect(onChangeValues).toHaveBeenCalledWith({ repository: review }));
        // The retired native mount cannot replace the first selected/cancelled settlement.
        await expect(pickerContext.hostApi.settleEphemeralInput({ kind: 'completed', input: review }))
            .rejects.toMatchObject({ code: 'stale_surface' });
        expect(onChangeValues.mock.calls).toEqual(pickerOnly ? [] : [[{ repository: review }]]);
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ method: 'input-relay:action.options.resolve',
            params: { v: 1, kind: 'targeted_action_rpc', target: { kind: 'machine', machineId: machine.id },
                input: { consumer: { kind: 'workflow', workflow }, fieldPath: 'repository', draftInput: { machineId: machine.id } } } }));
        expect(rpc.machine.mock.calls.filter(([request]) => request.method === 'input-relay:action.options.resolve')
            .every(([request]) => request.params.input.optionsSourceId === undefined)).toBe(true);
    });

    it('coalesces demanded reads, ignores free text, retains options during refresh, and cancels on last release', async () => {
        const { serverId } = await mount();
        rpc.machine.mockResolvedValue(reply);
        const field = { path: 'channels', optionsSourceId: 'notifications.channels.available' };
        type Props = { enabled: boolean; instructions: string; revision: string };
        const hook = await renderHook((props: Props) => useInputFieldOptions({
            requests: [{ field, draftInput: { instructions: props.instructions } }],
            enabled: props.enabled, serverId, refreshKey: props.revision,
        }), { initialProps: { enabled: false, instructions: '', revision: 'one' } });
        expect(rpc.machine).not.toHaveBeenCalled();
        await hook.rerender({ enabled: true, instructions: '', revision: 'one' });
        expect(hook.getCurrent().resolveOptions(field)).toEqual(reply.options);
        const options = hook.getCurrent().resolveOptions(field);
        await hook.rerender({ enabled: true, instructions: 'typing', revision: 'one' });
        expect(hook.getCurrent().resolveOptions(field)).toBe(options);
        expect(rpc.machine).toHaveBeenCalledTimes(1);
        let settle: ((value: typeof reply) => void) | undefined;
        rpc.machine.mockImplementation(() => new Promise<typeof reply>((resolve) => { settle = resolve; }));
        await hook.rerender({ enabled: true, instructions: 'typing', revision: 'two' });
        expect(hook.getCurrent().resolveOptions(field)).toBe(options);
        const requestId = rpc.machine.mock.calls.at(-1)![0].requestId;
        expect(requestId).toEqual(expect.any(String));
        await hook.unmount();
        expect(rpc.cancel).toHaveBeenCalledWith({ requestId });
        settle?.(reply);
    });
});
