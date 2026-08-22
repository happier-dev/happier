import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { sync as syncInstance } from '@/sync/sync';
import { createDeferred, renderScreen } from '@/dev/testkit';
import {
    applyComposerPresentationTransaction,
    createComposerPresentationHostHandlers,
    createComposerPresentationTransactionApplier,
    readComposerPresentationSnapshot,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import {
    attachBrowserContextToComposer,
    captureBrowserPageReference,
    createBrowserContextState,
    markBrowserContextViewNavigation,
    type BrowserContextState,
} from '@/sync/domains/browser/context';
import type {
    BrowserAdapterCapabilitiesV1,
    BrowserContextCapabilities,
    DaemonPluginUiComposerSurfaceCatalogEntryV1,
    PluginProjectionV2,
    PluginProjectedComposerAttachmentEntryV1,
    PluginProjectedComposerRegionEntryV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    installSessionActionsCommonModuleMocks,
    resetSessionActionsCommonModuleMockState,
} from '../../actions/sessionActionsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const agentInputSpy = vi.fn();
const modalAlertSpy = vi.fn();
type SubmitMessage = typeof syncInstance.submitMessage;
const syncSubmitMessageSpy = vi.fn<SubmitMessage>(async () => undefined);
const sessionExecutionRunSendSpy = vi.fn<
    (sessionId: string, request: { runId: string; message: string; delivery?: 'prompt' | 'steer_if_supported' | 'interrupt' }) => Promise<{ ok: boolean; error?: string }>
>(async () => ({ ok: true }));
const isExecutionRunNotRunningSendErrorSpy = vi.fn(() => false);
const randomUUIDSpy = vi.hoisted(() => vi.fn(() => 'participant-composer-scope'));
const machineRpcWithServerScopeSpy = vi.hoisted(() => vi.fn<
    (params: unknown) => Promise<unknown>
>(async () => ({})));
const participantDaemonProjectionState = vi.hoisted(() => ({
    current: null as unknown,
}));
const pluginSurfaceHostSpy = vi.hoisted(() => vi.fn());

const issueAttachmentCatalogEntry = {
    id: 'acme.issues/issue',
    pluginId: 'acme.issues',
    identity: { pluginId: 'acme.issues', localId: 'issue' },
    immutableGenerationId: 'issues-generation-1',
    definition: {
        id: 'issue',
        title: 'Issue',
        icon: 'file',
        cardinality: 'many',
        valueSchema: {
            type: 'object',
            required: ['issueId'],
            properties: { issueId: { type: 'integer' } },
            additionalProperties: false,
        },
    },
} satisfies PluginProjectedComposerAttachmentEntryV1;

const participantRegion = {
    id: 'acme.issues/participant-region',
    pluginId: 'acme.issues',
    identity: { pluginId: 'acme.issues', localId: 'participant-region' },
    immutableGenerationId: 'issues-generation-1',
    definition: {
        id: 'participant-region',
        placement: 'beforeComposer',
        renderer: { renderer: 'participant-region-renderer' },
        scopes: ['participantMessage'],
    },
} satisfies PluginProjectedComposerRegionEntryV1;

function createParticipantComposerCatalogEntry(): DaemonPluginUiComposerSurfaceCatalogEntryV1 {
    return {
        contribution: participantRegion.identity,
        immutableGenerationId: participantRegion.immutableGenerationId,
        projectionGeneration: 7,
        role: 'region',
        rendererChain: [{ pluginId: 'acme.issues', localId: 'participant-region-renderer' }],
        selectedRenderer: {
            identity: { pluginId: 'acme.issues', localId: 'participant-region-renderer' },
            renderer: {
                kind: 'declarative',
                contributionId: 'participant-region-renderer',
                model: { visible: true },
            },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        },
        executionOrigin: {
            serverIdentityId: 'server-1',
            materializationRef: {
                machineId: 'machine-1',
                materializationId: 'issues-materialization-1',
                pluginId: 'acme.issues',
            },
        },
        resourceCapability: { readable: true, dynamic: true },
        contributorTargetedContributions: {
            target: { pluginId: 'acme.issues', immutableGenerationId: 'issues-generation-1' },
            points: [],
        },
    } as DaemonPluginUiComposerSurfaceCatalogEntryV1;
}

function currentParticipantDaemonProjection(entriesById: Readonly<Record<string, PluginProjectedComposerAttachmentEntryV1>>) {
    const pluginProjectionV2: PluginProjectionV2 = {
        v: 2,
        generation: 7,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            composerAttachments: { family: 'composerAttachments', entriesById },
            composerRegions: {
                family: 'composerRegions',
                entriesById: { [participantRegion.id]: participantRegion },
            },
        },
        contributionIntrospection: {
            version: 1,
            generation: 7,
            contributions: [{
                version: 1,
                contribution: {
                    kind: 'localId',
                    pluginId: 'acme.issues',
                    family: 'composerReferences',
                    qualifiedId: 'acme.issues/issues',
                    localId: 'issues',
                },
                progression: { declared: true, normalized: true, merged: true },
                registration: { requirement: 'required', state: 'bound', generation: '7' },
                activation: { state: 'active', generation: '7' },
                projection: { state: 'projected' },
                presentation: {
                    kind: 'composerReference',
                    title: 'Issues',
                    icon: 'search',
                    triggers: ['@'],
                },
                consumer: 'composer-reference-host',
                platforms: ['cli', 'web'],
                diagnostics: [],
            }],
            diagnostics: [],
        },
        diagnostics: [],
    };
    return {
        phase: 'ready' as const,
        inputs: {
            pluginProjectionById: {},
            pluginProjectionV2,
            composerSurfaceCatalog: [createParticipantComposerCatalogEntry()],
        },
    };
}

function createIssueAttachmentTransactionApplier() {
    return createComposerPresentationTransactionApplier({
        composerAttachmentsById: {
            [issueAttachmentCatalogEntry.id]: issueAttachmentCatalogEntry,
        },
    });
}

const participantComposerRef = {
    kind: 'participantMessage' as const,
    sessionId: 's1',
    instanceId: 'participant-composer-scope',
};

async function seedParticipantComposerSemanticSnapshot() {
    const initial = readComposerPresentationSnapshot(participantComposerRef);
    if (!initial) throw new Error('expected mounted participant composer target');
    await act(async () => {
        expect(applyComposerPresentationTransaction({
            ref: participantComposerRef,
            transaction: {
                expectedRevision: initial.revision,
                operations: [
                    { kind: 'text.set', text: 'Captured participant @issue @new' },
                    {
                        kind: 'reference.insert',
                        reference: {
                            kind: 'partner.reference',
                            ref: 'partner:issue-42',
                            token: '@issue',
                            start: 21,
                            end: 27,
                            label: 'Issue #42',
                        },
                    },
                ],
            },
        }).status).toBe('applied');
        await flushHookEffects({ cycles: 1, turns: 1 });
    });
    const withReference = readComposerPresentationSnapshot(participantComposerRef);
    if (!withReference) throw new Error('expected participant reference snapshot');
    await act(async () => {
        expect(createIssueAttachmentTransactionApplier().apply({
            ref: participantComposerRef,
            admittedContributor: {
                identity: { pluginId: 'acme.issues', localId: 'composer-control' },
                immutableGenerationId: 'issues-generation-1',
            },
            transaction: {
                expectedRevision: withReference.revision,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                }],
            },
        }).status).toBe('applied');
        await flushHookEffects({ cycles: 1, turns: 1 });
    });
    const submitted = readComposerPresentationSnapshot(participantComposerRef);
    if (!submitted) throw new Error('expected participant semantic snapshot');
    return submitted;
}

const contextCapabilities = {
    enabled: true,
    available: true,
    supportedContextKinds: ['browserPageReference'],
    supportedAdapterKinds: ['localPreview'],
    screenshot: {
        supported: false,
        requiresAttachmentUploads: true,
    },
    text: {
        maxSelectionChars: 2048,
        maxSummaryChars: 8192,
    },
    disabledReasons: [],
    policyDeniedReasons: [],
} satisfies BrowserContextCapabilities;

const adapterCapabilities = {
    adapterKind: 'localPreview',
    supportedTargetKinds: ['localServicePreview'],
    supportedRenderEngines: ['webIframe'],
    navigation: {
        canNavigate: true,
        canGoBack: false,
        canGoForward: false,
        canReload: true,
        canStop: false,
    },
    diagnosticsFidelityByFamily: {
        pageInfo: 'previewProxy',
    },
    contextKinds: ['browserPageReference'],
    inputRouting: 'none',
    supportsDownloads: false,
    supportsUploads: false,
    supportsPopups: false,
    supportsPermissions: false,
    supportsStreamingDisplay: false,
    disabledReasons: [],
} satisfies BrowserAdapterCapabilitiesV1;

function createAttachedBrowserContextState(options: Readonly<{ stale?: boolean }> = {}): BrowserContextState {
    const captured = captureBrowserPageReference({
        state: createBrowserContextState(),
        browserContextEnabled: true,
        contextCapabilities,
        adapterCapabilities,
        viewId: 'view_1',
        target: {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 's1',
            machineId: 'machine_1',
            display: {
                title: 'Dashboard',
                addressLabel: 'localhost:5173',
            },
        },
        page: {
            url: 'https://preview.localhost.test/dashboard?token=secret#panel',
            title: 'Dashboard',
            navigationGeneration: 2,
            capturedAtMs: 4_000,
        },
    });
    if (captured.status !== 'captured') throw new Error('failed to build browser context fixture');

    const attached = attachBrowserContextToComposer(captured.state, {
        attachmentId: 'attachment_1',
        contextId: captured.itemId,
    });
    if (attached.status !== 'attached') throw new Error('failed to attach browser context fixture');

    return options.stale === true
        ? markBrowserContextViewNavigation(attached.state, {
            viewId: 'view_1',
            navigationGeneration: 3,
        })
        : attached.state;
}

installSessionActionsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('View', props, children),
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: (...args: unknown[]) => modalAlertSpy(...args),
            },
        }).module;
    },
});

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: unknown) => {
        agentInputSpy(props);
        return React.createElement('AgentInput', props as Record<string, unknown>);
    },
}));

// The participant contract asserts its own projection and physical target.
// Popover chrome is separately covered by the AgentInput primitive.
vi.mock('@/components/sessions/agentInput/components/AgentInputContentPopover', () => ({
    AgentInputContentPopover: (props: Readonly<{ content: () => React.ReactNode }>) => (
        <>{props.content()}</>
    ),
}));
vi.mock('@/components/sessions/agentInput/components/AgentInputPopoverSurface', () => ({
    AgentInputPopoverSurface: (props: Readonly<{ children?: React.ReactNode }>) => <>{props.children}</>,
}));

vi.mock(
    '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
    async (importOriginal) => {
        const { installServerScopedMachineRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
        return installServerScopedMachineRpcModuleMock({
            machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeSpy(params) as never,
        })(importOriginal);
    },
);

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => participantDaemonProjectionState.current,
}));
vi.mock('@/components/plugins/surfaces/PluginSurfaceHost', () => ({
    PluginSurfaceHost: (props: Record<string, unknown>) => {
        pluginSurfaceHostSpy(props);
        return React.createElement('PluginSurfaceHost', props);
    },
}));
// Composer-control chrome and contextual Resource transport have their own
// owner suites. This consumer test keeps the real catalog-to-physical-mount
// projection while replacing those already-covered descendants.
vi.mock('@/components/plugins/actions/pluginContributedActionComposerChips', () => ({
    createPluginContributedActionComposerChips: () => [],
}));
vi.mock('@/components/plugins/surfaces/PluginContextualResourceStoreProvider', () => ({
    PluginContextualResourceStoreProvider: (props: Readonly<{ children?: React.ReactNode }>) => <>{props.children}</>,
    PluginContextualResourceState: (props: Readonly<{
        children: (snapshot: null) => React.ReactNode;
    }>) => <>{props.children(null)}</>,
}));
vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: () => ({ machineId: 'machine-1' }),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server-1',
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunSend: (...args: Parameters<typeof sessionExecutionRunSendSpy>) => sessionExecutionRunSendSpy(...args),
    isExecutionRunNotRunningSendError: (...args: Parameters<typeof isExecutionRunNotRunningSendErrorSpy>) => isExecutionRunNotRunningSendErrorSpy(...args),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        submitMessage: (...args: Parameters<SubmitMessage>) => syncSubmitMessageSpy(...args),
    },
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => void promise,
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => randomUUIDSpy(),
}));

describe('SessionParticipantComposer', () => {
    beforeEach(() => {
        resetSessionActionsCommonModuleMockState();
        agentInputSpy.mockClear();
        modalAlertSpy.mockClear();
        syncSubmitMessageSpy.mockClear();
        sessionExecutionRunSendSpy.mockClear();
        isExecutionRunNotRunningSendErrorSpy.mockClear();
        randomUUIDSpy.mockClear();
        machineRpcWithServerScopeSpy.mockReset();
        machineRpcWithServerScopeSpy.mockResolvedValue({});
        pluginSurfaceHostSpy.mockClear();
        participantDaemonProjectionState.current = currentParticipantDaemonProjection({
            [issueAttachmentCatalogEntry.id]: issueAttachmentCatalogEntry,
        });
    });

    it('routes execution-run sends through sessionExecutionRunSend', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            executionRunDelivery="interrupt"
        />);

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('Refine the current review');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(sessionExecutionRunSendSpy).toHaveBeenCalledWith('s1', {
            runId: 'run_1',
            message: 'Refine the current review',
            delivery: 'interrupt',
        });
        expect(syncSubmitMessageSpy).not.toHaveBeenCalled();
    });

    it('projects the mounted action-bar layout through the participant Composer snapshot', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={null}
        />);

        const composerRef = {
            kind: 'participantMessage' as const,
            sessionId: 's1',
            instanceId: 'participant-composer-scope',
        };
        const inputProps = agentInputSpy.mock.lastCall?.[0] as Readonly<{
            onComposerActionBarLayoutChange?: (layout: 'wrap' | 'scroll' | 'collapsed') => void;
        }>;
        expect(readComposerPresentationSnapshot(composerRef)?.layout).toBe('wrap');
        expect(inputProps.onComposerActionBarLayoutChange).toEqual(expect.any(Function));

        inputProps.onComposerActionBarLayoutChange?.('scroll');
        expect(readComposerPresentationSnapshot(composerRef)?.layout).toBe('scroll');

        inputProps.onComposerActionBarLayoutChange?.('collapsed');
        expect(readComposerPresentationSnapshot(composerRef)?.layout).toBe('collapsed');
    });

    it('mounts participant regions through the shared host on the participant Session target', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={null}
        />);

        expect(pluginSurfaceHostSpy).toHaveBeenCalledWith(expect.objectContaining({
            composerMount: expect.objectContaining({
                physicalTarget: { kind: 'session', sessionId: 's1' },
                mount: expect.objectContaining({
                    kind: 'composer',
                    mount: expect.objectContaining({
                        role: 'region',
                        input: expect.objectContaining({
                            composer: {
                                kind: 'participantMessage',
                                sessionId: 's1',
                                instanceId: 'participant-composer-scope',
                            },
                        }),
                    }),
                }),
            }),
        }));
    });

    it('shows provider rows only through the current focused participant scope', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');
        const screen = await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={null}
        />);

        type ParticipantAutocompleteProps = Readonly<{
            autocompleteKinds: readonly string[];
            autocompleteSuggestions: (query: string, signal: AbortSignal) => Promise<unknown>;
            onComposerFocusChange: (focused: boolean) => void;
        }>;
        let firstProps = agentInputSpy.mock.lastCall?.[0] as ParticipantAutocompleteProps;
        expect(firstProps.autocompleteKinds).toEqual([
            'file',
            'vendorPlugin',
            'composerReference',
            'slashCommand',
        ]);
        machineRpcWithServerScopeSpy
            .mockResolvedValueOnce({
                ok: true,
                reference: { pluginId: 'acme.issues', localId: 'issues' },
                page: [{ id: 'participant-42', label: 'Participant issue #42' }],
            })
            .mockResolvedValueOnce({
                ok: true,
                reference: { pluginId: 'acme.issues', localId: 'issues' },
                page: [{ id: 'participant-99', label: 'Participant issue #99' }],
            });
        await act(async () => {
            firstProps.onComposerFocusChange(true);
            const suggestions = await firstProps.autocompleteSuggestions('@issue', new AbortController().signal);
            expect(suggestions).toEqual([
                expect.objectContaining({
                    kind: 'composerReference',
                    label: 'Participant issue #42',
                }),
            ]);
        });
        expect(machineRpcWithServerScopeSpy).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: RPC_METHODS.DAEMON_PLUGIN_COMPOSER_REFERENCE_SEARCH,
            payload: expect.objectContaining({
                expectedGeneration: '7',
                reference: { pluginId: 'acme.issues', localId: 'issues' },
                trigger: '@',
                query: 'issue',
            }),
            signal: expect.any(AbortSignal),
        }));

        await act(async () => {
            screen.tree.update(<SessionParticipantComposer
                sessionId="s2"
                canSendMessages
                recipient={null}
            />);
        });
        const callsBeforeStaleSearch = machineRpcWithServerScopeSpy.mock.calls.length;
        await act(async () => {
            await expect(firstProps.autocompleteSuggestions('@issue', new AbortController().signal)).resolves.toEqual([]);
        });
        expect(machineRpcWithServerScopeSpy).toHaveBeenCalledTimes(callsBeforeStaleSearch);

        const secondProps = agentInputSpy.mock.lastCall?.[0] as ParticipantAutocompleteProps;
        await act(async () => {
            secondProps.onComposerFocusChange(true);
            const suggestions = await secondProps.autocompleteSuggestions('@issue', new AbortController().signal);
            expect(suggestions).toEqual([
                expect.objectContaining({
                    kind: 'composerReference',
                    label: 'Participant issue #99',
                }),
            ]);
        });
        expect(machineRpcWithServerScopeSpy).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: RPC_METHODS.DAEMON_PLUGIN_COMPOSER_REFERENCE_SEARCH,
            payload: expect.objectContaining({ query: 'issue' }),
        }));
    });

    it('projects a separate participant composer and submits its contentless attachments', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={null}
        />);

        const ref = {
            kind: 'participantMessage' as const,
            sessionId: 's1',
            instanceId: 'participant-composer-scope',
        };
        const initial = readComposerPresentationSnapshot(ref);
        expect(initial).toMatchObject({
            ref,
            text: '',
            attachments: [],
            capabilities: {
                text: true,
                references: true,
                attachments: true,
                submit: true,
            },
        });

        expect(initial).not.toBeNull();
        if (!initial) throw new Error('expected mounted participant composer target');

        await act(async () => {
            const applied = createIssueAttachmentTransactionApplier().apply({
                ref,
                admittedContributor: {
                    identity: { pluginId: 'acme.issues', localId: 'composer-control' },
                    immutableGenerationId: 'issues-generation-1',
                },
                transaction: {
                    expectedRevision: initial.revision,
                    operations: [{
                        kind: 'attachment.add',
                        attachmentLocalId: 'issue',
                        value: {
                            key: '42',
                            value: { issueId: 42 },
                            presentation: { label: 'Issue #42' },
                        },
                    }],
                },
            });
            expect(applied.status).toBe('applied');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            hasSendableAttachments?: boolean;
            onSend: () => void;
        };
        expect(agentInputProps.hasSendableAttachments).toBe(true);

        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
            's1',
            '',
            undefined,
            expect.objectContaining({
                happierStructuredInputV1: {
                    v: 1,
                    composerAttachments: [{
                        v: 1,
                        instanceId: expect.any(String),
                        attachment: { pluginId: 'acme.issues', localId: 'issue' },
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                    }],
                },
            }),
            expect.objectContaining({ callerSurface: 'participant_composer' }),
        );
        expect(readComposerPresentationSnapshot(ref)?.attachments).toEqual([]);
    });

    it('keeps an uninstalled or incompatible participant attachment visible and non-sendable until the current generation returns', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={null}
        />);

        const ref = {
            kind: 'participantMessage' as const,
            sessionId: 's1',
            instanceId: 'participant-composer-scope',
        };
        const initial = readComposerPresentationSnapshot(ref);
        if (!initial) throw new Error('expected mounted participant composer target');

        await act(async () => {
            expect(createIssueAttachmentTransactionApplier().apply({
                ref,
                admittedContributor: {
                    identity: { pluginId: 'acme.issues', localId: 'composer-control' },
                    immutableGenerationId: 'issues-generation-1',
                },
                transaction: {
                    expectedRevision: initial.revision,
                    operations: [{
                        kind: 'attachment.add',
                        attachmentLocalId: 'issue',
                        value: {
                            key: '42',
                            value: { issueId: 42 },
                            presentation: { label: 'Issue #42' },
                        },
                    }],
                },
            }).status).toBe('applied');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            attachmentRowItems: readonly { availability?: string; onRemove?: () => void }[];
            hasSendableAttachments?: boolean;
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        expect(agentInputProps.hasSendableAttachments).toBe(true);

        participantDaemonProjectionState.current = {
            phase: 'loading',
            inputs: null,
        };
        await act(async () => {
            agentInputProps.onChangeText('Keep this unavailable participant draft');
        });

        agentInputProps = agentInputSpy.mock.lastCall?.[0] as typeof agentInputProps;
        expect(agentInputProps.hasSendableAttachments).toBe(false);
        expect(agentInputProps.attachmentRowItems).toEqual([expect.objectContaining({
            availability: 'unavailable',
            onRemove: expect.any(Function),
        })]);
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        expect(syncSubmitMessageSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'common.unavailable');
        expect(readComposerPresentationSnapshot(ref)).toMatchObject({
            text: 'Keep this unavailable participant draft',
            attachments: [expect.objectContaining({
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            availability: { status: 'unavailable' },
            })],
        });

        const reinstalled = {
            ...issueAttachmentCatalogEntry,
            immutableGenerationId: 'issues-generation-2',
        };
        participantDaemonProjectionState.current = currentParticipantDaemonProjection({
            [reinstalled.id]: reinstalled,
        });
        await act(async () => {
            agentInputProps.onChangeText('Restored participant draft');
        });

        agentInputProps = agentInputSpy.mock.lastCall?.[0] as typeof agentInputProps;
        expect(agentInputProps.hasSendableAttachments).toBe(true);
        expect(readComposerPresentationSnapshot(ref)?.attachments).toEqual([expect.objectContaining({
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            availability: { status: 'ready' },
        })]);

        participantDaemonProjectionState.current = currentParticipantDaemonProjection({
            [issueAttachmentCatalogEntry.id]: {
                ...issueAttachmentCatalogEntry,
                immutableGenerationId: 'issues-generation-3',
                definition: {
                    ...issueAttachmentCatalogEntry.definition,
                    valueSchema: {
                        type: 'object',
                        required: ['slug'],
                        properties: { slug: { type: 'string' } },
                        additionalProperties: false,
                    },
                },
            },
        });
        await act(async () => {
            agentInputProps.onChangeText('Keep this invalid participant draft');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as typeof agentInputProps;
        expect(agentInputProps.hasSendableAttachments).toBe(false);
        expect(agentInputProps.attachmentRowItems).toEqual([expect.objectContaining({
            availability: 'invalid',
            onRemove: expect.any(Function),
        })]);
        modalAlertSpy.mockClear();
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        expect(syncSubmitMessageSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'common.unavailable');
        expect(readComposerPresentationSnapshot(ref)).toMatchObject({
            text: 'Keep this invalid participant draft',
            attachments: [expect.objectContaining({ availability: { status: 'invalid' } })],
        });
    });

    it('projects decorations and edit locks into the mounted participant input', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={null}
        />);

        const ref = {
            kind: 'participantMessage' as const,
            sessionId: 's1',
            instanceId: 'participant-composer-scope',
        };
        const snapshot = readComposerPresentationSnapshot(ref);
        expect(snapshot).not.toBeNull();
        if (!snapshot) throw new Error('expected mounted participant composer target');
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
        });
        const request = (method: 'setComposerDecorations' | 'acquireComposerInputLock' | 'disposeHostResource', payload: unknown) => ({
            version: 1,
            requestId: `request:${method}`,
            surface: {
                pluginId: 'acme.fixture',
                contributionId: 'composer-tools',
                surfaceId: 'composer-tools:mounted',
                placement: 'composerSurface',
                platform: 'web',
                channel: 'internal',
                resourceScope: [],
                diagnostics: [],
            },
            method,
            payload,
        }) as never;

        await act(async () => {
            expect(handlers.setComposerDecorations!(request('setComposerDecorations', {
                ref,
                key: 'analysis',
                decorations: {
                    revision: snapshot.revision,
                    ranges: [{ range: { start: 0, end: 0 }, treatment: 'warning' }],
                },
            }))).toEqual({ status: 'set' });
        });
        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as Readonly<{
            composerDecorations?: readonly Readonly<{ key: string }>[];
            composerInputLock?: unknown;
            disabled?: boolean;
            isSendDisabled?: boolean;
        }>;
        expect(agentInputProps.composerDecorations).toEqual([
            expect.objectContaining({ key: 'analysis' }),
        ]);

        await act(async () => {
            expect(handlers.acquireComposerInputLock!(request('acquireComposerInputLock', {
                subscriptionId: 'lock-1',
                ref,
                request: { reason: 'Review required', mode: 'editAndSubmit' },
            }))).toBeNull();
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as typeof agentInputProps;
        expect(agentInputProps.composerInputLock).toEqual({
            mode: 'editAndSubmit',
            reasons: ['Review required'],
        });
        expect(agentInputProps.disabled).toBe(true);
        expect(agentInputProps.isSendDisabled).toBe(true);

        await act(async () => {
            expect(handlers.disposeHostResource!(request('disposeHostResource', {
                subscriptionId: 'lock-1',
            }))).toBeNull();
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as typeof agentInputProps;
        expect(agentInputProps.composerInputLock).toBeNull();
        expect(agentInputProps.disabled).toBe(false);
        expect(agentInputProps.isSendDisabled).toBe(false);
        await act(async () => {
            handlers.dispose();
        });
    });

    it('uses the mounted participant input for active and exact focus requests', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');
        const focus = vi.fn();

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={null}
        />);

        const ref = {
            kind: 'participantMessage' as const,
            sessionId: 's1',
            instanceId: 'participant-composer-scope',
        };
        const agentInputProps = agentInputSpy.mock.lastCall?.[0] as Readonly<{
            onComposerFocusChange: (focused: boolean) => void;
            onComposerFocusRequestChange: (request: (() => void) | null) => void;
        }>;
        expect(agentInputProps.onComposerFocusChange).toEqual(expect.any(Function));
        expect(agentInputProps.onComposerFocusRequestChange).toEqual(expect.any(Function));
        await act(async () => {
            agentInputProps.onComposerFocusRequestChange(focus);
            agentInputProps.onComposerFocusChange(true);
        });

        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
        });
        const request = (method: 'activeComposer' | 'focusComposer', payload?: unknown) => ({
            version: 1,
            requestId: `request:${method}`,
            surface: {
                pluginId: 'acme.fixture',
                contributionId: 'composer-tools',
                surfaceId: 'composer-tools:mounted',
                placement: 'composerSurface',
                platform: 'web',
                channel: 'internal',
                resourceScope: [],
                diagnostics: [],
            },
            method,
            ...(payload === undefined ? {} : { payload }),
        }) as never;

        expect(handlers.activeComposer!(request('activeComposer'))).toEqual(ref);
        expect(handlers.focusComposer!(request('focusComposer', { ref })))
            .toEqual({ status: 'focused' });
        expect(focus).toHaveBeenCalledTimes(1);
        handlers.dispose();
    });

    it('admits the detached participant snapshot through the coordinator and clears only its accepted document', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={null}
        />);

        const ref = {
            kind: 'participantMessage' as const,
            sessionId: 's1',
            instanceId: 'participant-composer-scope',
        };
        const initial = readComposerPresentationSnapshot(ref);
        expect(initial).not.toBeNull();
        if (!initial) throw new Error('expected mounted participant composer target');

        await act(async () => {
            expect(applyComposerPresentationTransaction({
                ref,
                transaction: {
                    expectedRevision: initial.revision,
                    operations: [
                        { kind: 'text.set', text: 'Review @issue' },
                        {
                            kind: 'reference.insert',
                            reference: {
                                kind: 'partner.reference',
                                ref: 'partner:issue-42',
                                token: '@issue',
                                start: 7,
                                end: 13,
                                label: 'Issue #42',
                            },
                        },
                    ],
                },
            }).status).toBe('applied');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        const agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
            's1',
            'Review @issue',
            undefined,
            expect.objectContaining({
                happierStructuredInputV1: {
                    v: 1,
                    mentions: [{
                        kind: 'partner.reference',
                        ref: 'partner:issue-42',
                        token: '@issue',
                        label: 'Issue #42',
                    }],
                },
            }),
            expect.objectContaining({ callerSurface: 'participant_composer' }),
        );
        expect(readComposerPresentationSnapshot(ref)).toMatchObject({
            text: '',
            references: [],
            attachments: [],
        });
    });

    it('retains the participant document when coordinator admission rejects it', async () => {
        syncSubmitMessageSpy.mockRejectedValueOnce(new Error('participant send rejected'));
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={null}
        />);

        const submitted = await seedParticipantComposerSemanticSnapshot();
        const agentInputProps = agentInputSpy.mock.lastCall?.[0] as { onSend: () => void };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(readComposerPresentationSnapshot(participantComposerRef)).toMatchObject({
            text: submitted.text,
            references: submitted.references,
            attachments: submitted.attachments,
        });
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'participant send rejected');
    });

    it('preserves a participant reference whose exact token remains in newer text after acceptance', async () => {
        const submission = createDeferred<void>();
        syncSubmitMessageSpy.mockImplementationOnce(() => submission.promise);
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={null}
        />);

        const ref = {
            kind: 'participantMessage' as const,
            sessionId: 's1',
            instanceId: 'participant-composer-scope',
        };
        const initial = readComposerPresentationSnapshot(ref);
        if (!initial) throw new Error('expected mounted participant composer target');
        await act(async () => {
            expect(applyComposerPresentationTransaction({
                ref,
                transaction: {
                    expectedRevision: initial.revision,
                    operations: [
                        { kind: 'text.set', text: 'Captured participant @issue' },
                        {
                            kind: 'reference.insert',
                            reference: {
                                kind: 'partner.reference',
                                ref: 'partner:issue-42',
                                token: '@issue',
                                start: 21,
                                end: 27,
                                label: 'Issue #42',
                            },
                        },
                    ],
                },
            }).status).toBe('applied');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        const withReference = readComposerPresentationSnapshot(ref);
        if (!withReference) throw new Error('expected participant reference snapshot');
        await act(async () => {
            expect(createIssueAttachmentTransactionApplier().apply({
                ref,
                admittedContributor: {
                    identity: { pluginId: 'acme.issues', localId: 'composer-control' },
                    immutableGenerationId: 'issues-generation-1',
                },
                transaction: {
                    expectedRevision: withReference.revision,
                    operations: [{
                        kind: 'attachment.add',
                        attachmentLocalId: 'issue',
                        value: {
                            key: '42',
                            value: { issueId: 42 },
                            presentation: { label: 'Issue #42' },
                        },
                    }],
                },
            }).status).toBe('applied');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as typeof agentInputProps;
        await act(async () => {
            agentInputProps.onSend();
            await Promise.resolve();
        });
        expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
            's1',
            'Captured participant @issue',
            undefined,
            expect.objectContaining({
                happierStructuredInputV1: expect.objectContaining({
                    mentions: [expect.objectContaining({ ref: 'partner:issue-42' })],
                    composerAttachments: [expect.objectContaining({
                        attachment: { pluginId: 'acme.issues', localId: 'issue' },
                        value: { issueId: 42 },
                    })],
                }),
            }),
            expect.objectContaining({ callerSurface: 'participant_composer' }),
        );

        agentInputProps = agentInputSpy.mock.lastCall?.[0] as typeof agentInputProps;
        await act(async () => {
            agentInputProps.onChangeText('Newer participant @issue');
        });
        submission.resolve();
        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(readComposerPresentationSnapshot(ref)).toMatchObject({
            text: 'Newer participant @issue',
            references: [expect.objectContaining({ ref: 'partner:issue-42', token: '@issue' })],
            attachments: [],
        });
    });

    it('clears text-bound newer participant references together with unchanged accepted text', async () => {
        const submission = createDeferred<void>();
        syncSubmitMessageSpy.mockImplementationOnce(() => submission.promise);
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={null}
        />);

        const submitted = await seedParticipantComposerSemanticSnapshot();
        const agentInputProps = agentInputSpy.mock.lastCall?.[0] as { onSend: () => void };
        await act(async () => {
            agentInputProps.onSend();
            await Promise.resolve();
        });

        await act(async () => {
            expect(applyComposerPresentationTransaction({
                ref: participantComposerRef,
                transaction: {
                    expectedRevision: submitted.revision,
                    operations: [{
                        kind: 'reference.insert',
                        reference: {
                            kind: 'partner.reference',
                            ref: 'partner:issue-99',
                            token: '@new',
                            start: 28,
                            end: 32,
                            label: 'Issue #99',
                        },
                    }],
                },
            }).status).toBe('applied');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        submission.resolve();
        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(readComposerPresentationSnapshot(participantComposerRef)).toMatchObject({
            text: '',
            references: [],
            attachments: [],
        });
        const currentAgentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            structuredInputMentions?: readonly { ref?: string }[];
        };
        expect(currentAgentInputProps.structuredInputMentions).toEqual([]);
    });

    it('clears unchanged participant text and references when an attachment changes after submission', async () => {
        const submission = createDeferred<void>();
        syncSubmitMessageSpy.mockImplementationOnce(() => submission.promise);
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={null}
        />);

        const submitted = await seedParticipantComposerSemanticSnapshot();
        const agentInputProps = agentInputSpy.mock.lastCall?.[0] as { onSend: () => void };
        await act(async () => {
            agentInputProps.onSend();
            await Promise.resolve();
        });

        const acceptedAttachment = submitted.attachments[0];
        if (!acceptedAttachment) throw new Error('expected accepted participant attachment');
        await act(async () => {
            expect(createIssueAttachmentTransactionApplier().apply({
                ref: participantComposerRef,
                admittedContributor: {
                    identity: { pluginId: 'acme.issues', localId: 'composer-control' },
                    immutableGenerationId: 'issues-generation-1',
                },
                transaction: {
                    expectedRevision: submitted.revision,
                    operations: [{
                        kind: 'attachment.update',
                        instanceId: acceptedAttachment.instanceId,
                        update: {
                            value: { issueId: 99 },
                            presentation: { label: 'Issue #99' },
                        },
                    }],
                },
            }).status).toBe('applied');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        submission.resolve();
        await act(async () => {
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(readComposerPresentationSnapshot(participantComposerRef)).toMatchObject({
            text: '',
            references: [],
            attachments: [expect.objectContaining({
                instanceId: acceptedAttachment.instanceId,
                value: { issueId: 99 },
            })],
        });
    });

    it('clears the accepted participant snapshot when durable pending admission later reports a wake failure', async () => {
        syncSubmitMessageSpy.mockImplementationOnce(async (
            _sessionId,
            _text,
            _displayText,
            _metaOverrides,
            options,
        ) => {
            options?.onOutboundHandoff?.({ persistence: 'pending', localId: 'participant-pending-1' });
            throw new Error('participant wake failed');
        });
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={null}
        />);

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('Durably queued participant draft');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as typeof agentInputProps;
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(readComposerPresentationSnapshot({
            kind: 'participantMessage',
            sessionId: 's1',
            instanceId: 'participant-composer-scope',
        })?.text).toBe('');
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'participant wake failed');
    });

    it('rejects generic attachments for execution-run delivery without losing the participant draft', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
        />);

        const ref = {
            kind: 'participantMessage' as const,
            sessionId: 's1',
            instanceId: 'participant-composer-scope',
        };
        const initial = readComposerPresentationSnapshot(ref);
        expect(initial).not.toBeNull();
        if (!initial) throw new Error('expected mounted participant composer target');

        await act(async () => {
            expect(createIssueAttachmentTransactionApplier().apply({
                ref,
                admittedContributor: {
                    identity: { pluginId: 'acme.issues', localId: 'composer-control' },
                    immutableGenerationId: 'issues-generation-1',
                },
                transaction: {
                    expectedRevision: initial.revision,
                    operations: [{
                        kind: 'attachment.add',
                        attachmentLocalId: 'issue',
                        value: {
                            key: '42',
                            value: { issueId: 42 },
                            presentation: { label: 'Issue #42' },
                        },
                    }],
                },
            }).status).toBe('applied');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        const agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(sessionExecutionRunSendSpy).not.toHaveBeenCalled();
        expect(syncSubmitMessageSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'runs.send.failedToSend');
        expect(readComposerPresentationSnapshot(ref)?.attachments).toEqual([
            expect.objectContaining({
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '42',
            }),
        ]);
    });

    it('routes agent-team sends through sync.submitMessage with participant meta', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{
                kind: 'agent_team_member',
                teamId: 'qa-team',
                memberId: 'alpha@qa-team',
                memberLabel: 'alpha',
            }}
        />);

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('Please focus on regressions only');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
            's1',
            'Please focus on regressions only',
            undefined,
            expect.objectContaining({
                happier: expect.objectContaining({
                    kind: 'participant_message.v1',
                    payload: expect.objectContaining({
                        recipient: expect.objectContaining({
                            kind: 'agent_team_member',
                            teamId: 'qa-team',
                            memberId: 'alpha@qa-team',
                        }),
                    }),
                }),
            }),
            expect.objectContaining({
                callerSurface: 'participant_composer',
            }),
        );
        expect(sessionExecutionRunSendSpy).not.toHaveBeenCalled();
    });

    it('merges attached browser context metadata into participant message sends', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{
                kind: 'agent_team_member',
                teamId: 'qa-team',
                memberId: 'alpha@qa-team',
                memberLabel: 'alpha',
            }}
            browserContextState={createAttachedBrowserContextState()}
        />);

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: (options?: { structuredInputMetaOverrides?: Record<string, unknown> }) => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('Use the attached browser page');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: (options?: { structuredInputMetaOverrides?: Record<string, unknown> }) => void;
        };
        await act(async () => {
            agentInputProps.onSend({
                structuredInputMetaOverrides: {
                    happierStructuredInputV1: {
                        v: 1,
                        vendorPluginMentions: [{
                            vendorPluginRef: 'plugin://gmail@openai-curated',
                            label: 'Gmail',
                        }],
                    },
                },
            });
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
            's1',
            'Use the attached browser page',
            undefined,
            expect.objectContaining({
                happier: expect.objectContaining({
                    kind: 'participant_message.v1',
                }),
                happierStructuredInputV1: expect.objectContaining({
                    v: 1,
                    vendorPluginMentions: [{
                        vendorPluginRef: 'plugin://gmail@openai-curated',
                        label: 'Gmail',
                    }],
                }),
                happierBrowserContext: expect.objectContaining({
                    kind: 'browser_context.v1',
                    payload: expect.objectContaining({
                        contexts: [expect.objectContaining({
                            kind: 'browserPageReference',
                            url: 'https://preview.localhost.test/dashboard',
                        })],
                        attachments: [expect.objectContaining({
                            attachmentId: 'attachment_1',
                            state: 'available',
                        })],
                    }),
                }),
            }),
            expect.objectContaining({
                callerSurface: 'participant_composer',
            }),
        );
        expect(JSON.stringify(syncSubmitMessageSpy.mock.calls)).not.toContain('secret');
    });

    it('keeps structured input metadata on an un-routed participant composer send', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={null}
        />);

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: (options?: { structuredInputMetaOverrides?: Record<string, unknown> }) => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('Use the selected plugin');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: (options?: { structuredInputMetaOverrides?: Record<string, unknown> }) => void;
        };
        await act(async () => {
            agentInputProps.onSend({
                structuredInputMetaOverrides: {
                    happierStructuredInputV1: {
                        v: 1,
                        vendorPluginMentions: [{
                            vendorPluginRef: 'plugin://gmail@openai-curated',
                            label: 'Gmail',
                        }],
                    },
                },
            });
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
            's1',
            'Use the selected plugin',
            undefined,
            expect.objectContaining({
                happierStructuredInputV1: expect.objectContaining({
                    v: 1,
                    vendorPluginMentions: [{
                        vendorPluginRef: 'plugin://gmail@openai-curated',
                        label: 'Gmail',
                    }],
                }),
            }),
            expect.objectContaining({
                callerSurface: 'participant_composer',
            }),
        );
    });

    it('blocks participant sends when attached browser context is stale', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={null}
            browserContextState={createAttachedBrowserContextState({ stale: true })}
        />);

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('This should wait for fresh context');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(syncSubmitMessageSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'browserContext.composer.contextUnavailable');
    });

    it('blocks execution-run sends when browser context is attached because execution-run messages have no metadata channel', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            browserContextState={createAttachedBrowserContextState()}
        />);

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('Use the browser page');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(sessionExecutionRunSendSpy).not.toHaveBeenCalled();
        expect(syncSubmitMessageSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'browserContext.composer.contextUnavailable');
    });

    it('clears the focused execution-run recipient when the run is no longer running', async () => {
        sessionExecutionRunSendSpy.mockResolvedValueOnce({ ok: false, error: 'execution_run_not_running' });
        isExecutionRunNotRunningSendErrorSpy.mockReturnValueOnce(true);

        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');
        const onExecutionRunUnavailable = vi.fn();

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            onExecutionRunUnavailable={onExecutionRunUnavailable}
        />);

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('Ping');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(onExecutionRunUnavailable).toHaveBeenCalledTimes(1);
        expect(modalAlertSpy).toHaveBeenCalled();
    });

    it('passes extra action chips through to AgentInput', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');
        const extraActionChips = [{
            key: 'recipient',
            render: () => null,
        }] satisfies readonly AgentInputExtraActionChip[];

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            extraActionChips={extraActionChips}
        />);

        expect(agentInputSpy).toHaveBeenCalledWith(expect.objectContaining({
            extraActionChips,
        }));
    });
});
