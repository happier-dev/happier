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
import {
    DaemonPluginUiComposerSurfaceCatalogEntryV1Schema,
    type BrowserAdapterCapabilitiesV1,
    type BrowserContextCapabilities,
    type DaemonPluginUiComposerSurfaceCatalogEntryV1,
    type PluginProjectionV2,
    type PluginProjectedComposerAttachmentEntryV1,
    type PluginProjectedComposerRegionEntryV1,
} from '@happier-dev/protocol';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    installSessionActionsCommonModuleMocks,
    resetSessionActionsCommonModuleMockState,
} from '../../actions/sessionActionsTestHelpers';
import {
    clearSessionAttachmentDrafts,
    readSessionAttachmentDrafts,
} from '@/components/sessions/attachments/sessionAttachmentDraftStore';
import {
    createEphemeralComposerDocumentOwner,
    promoteAcceptedComposerDocument,
    type MutableComposerDocumentOwner,
} from '@/components/sessions/composer/composerDocumentOwner';
import type { ParticipantComposerPreparedSubmission } from './SessionParticipantComposer';

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
const sessionAttachmentsUploadFileSpy = vi.hoisted(() => vi.fn());
const participantDaemonProjectionState = vi.hoisted(() => ({
    current: null as unknown,
}));
const participantAccountBindingState = vi.hoisted(() => ({
    accountId: 'account-1',
}));
const pluginSurfaceHostSpy = vi.hoisted(() => vi.fn());

const issueAttachmentCatalogEntry = {
    id: 'acme.issues/issue',
    pluginId: 'acme.issues',
    identity: { pluginId: 'acme.issues', localId: 'issue' },
    occurrenceId: 'issues-generation-1',
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
    occurrenceId: 'issues-generation-1',
    definition: {
        id: 'participant-region',
        placement: 'beforeComposer',
        renderer: { renderer: 'participant-region-renderer' },
        scopes: ['participantMessage'],
    },
} satisfies PluginProjectedComposerRegionEntryV1;

function createParticipantComposerCatalogEntry(): DaemonPluginUiComposerSurfaceCatalogEntryV1 {
    return DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.parse({
        contribution: participantRegion.identity,
        occurrenceId: participantRegion.occurrenceId,
        projectionGeneration: 7,
        role: 'region',
        rendererChain: [{ pluginId: 'acme.issues', localId: 'participant-region-renderer' }],
        selectedRenderer: {
            identity: { pluginId: 'acme.issues', localId: 'participant-region-renderer' },
            renderer: {
                kind: 'declarative',
                contributionId: 'participant-region-renderer',
            },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        },
        executionOrigin: {
            serverIdentityId: 'srv_server-1',
            materializationRef: {
                machineId: 'machine-1',
                materializationId: 'issues-materialization-1',
                pluginId: 'acme.issues',
            },
        },
        resourceCapability: { readable: true, dynamic: true },
        contributorTargetedContributions: {
            target: {
                pluginId: 'acme.issues',
                occurrenceId: 'issues-generation-1',
                sourceCustody: { kind: 'development', registeredRootId: 'issues-root' },
            },
            points: [],
        },
    });
}

function currentParticipantDaemonProjection(entriesById: Readonly<Record<string, PluginProjectedComposerAttachmentEntryV1>>) {
    const pluginProjectionV2: PluginProjectionV2 = {
        v: 2,
        generation: 7,
        installedPackagesById: {},
        agentsById: {},
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
                occurrenceId: '7',
                contribution: {
                    kind: 'localId',
                    pluginId: 'acme.issues',
                    family: 'composerReferences',
                    qualifiedId: 'acme.issues/issues',
                    localId: 'issues',
                },
                progression: { declared: true, normalized: true, merged: true },
                registration: { requirement: 'required', state: 'bound', occurrenceId: '7' },
                activation: { state: 'active', occurrenceId: '7' },
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
            [issueAttachmentCatalogEntry.id]: {
                ...issueAttachmentCatalogEntry,
                valueValidator: () => true,
            },
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
                occurrenceId: 'issues-generation-1',
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
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'attachments.uploads',
}));
vi.mock('@/components/sessions/files/useSessionFileUploadAvailability', () => ({
    useSessionFileUploadAvailability: () => true,
}));
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
    AttachmentFilePicker: () => null,
}));
vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    useServerCredentialAccountScopeBindings: (serverIds: readonly string[]) => new Map(serverIds.map((serverId) => [serverId, {
        serverId,
        accountId: participantAccountBindingState.accountId,
        scope: { serverId, accountId: participantAccountBindingState.accountId },
        isCurrent: () => true,
        onRetire: () => ({ dispose: () => undefined }),
    }])),
}));
vi.mock('@/sync/domains/transfers/ops/uploadSessionAttachment', () => ({
    sessionAttachmentsUploadFile: (args: unknown) => sessionAttachmentsUploadFileSpy(args),
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
        sessionAttachmentsUploadFileSpy.mockReset();
        sessionAttachmentsUploadFileSpy.mockResolvedValue({
            success: true,
            path: '.happier/uploads/messages/first-input-1/notes.txt',
            sizeBytes: 5,
            sha256: 'sha-notes',
        });
        machineRpcWithServerScopeSpy.mockReset();
        machineRpcWithServerScopeSpy.mockResolvedValue({});
        pluginSurfaceHostSpy.mockClear();
        participantAccountBindingState.accountId = 'account-1';
        participantDaemonProjectionState.current = currentParticipantDaemonProjection({
            [issueAttachmentCatalogEntry.id]: issueAttachmentCatalogEntry,
        });
    });

    it('admits execution-run sends through canonical Session input with the exact target and delivery', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            executionRunRequestedAction={{ v: 1, kind: 'send_now' }}
            initialLocalId="first-input-1"
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

        // The composer's persisted delivery selection is normalized into the one
        // canonical pending vocabulary; `interrupt` means cancel-then-send, which is
        // `send_now`, not a Run-only delivery word.
        expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
            's1',
            'Refine the current review',
            undefined,
            expect.objectContaining({
                happier: expect.objectContaining({
                    kind: 'participant_message.v1',
                }),
            }),
            expect.objectContaining({
                recipient: { kind: 'execution_run', runId: 'run_1' },
                requestedAction: { v: 1, kind: 'send_now' },
                callerSurface: 'participant_composer',
                localId: 'first-input-1',
            }),
        );
        expect(sessionExecutionRunSendSpy).not.toHaveBeenCalled();
    });

    it('uploads an immediately attached file through the ordinary Session transfer owner before admitting the exact Run input', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');
        syncSubmitMessageSpy.mockImplementation(async (...args) => {
            args[4]?.onOutboundHandoff?.({ persistence: 'pending', localId: 'first-input-1' });
            return undefined;
        });

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            serverId="server-1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            initialLocalId="first-input-1"
            draftOccurrenceId="run-draft-1"
        />);

        const props = agentInputSpy.mock.lastCall?.[0] as {
            onAttachmentsAdded: (files: readonly File[]) => void;
            onSend: (options?: { inputTextOverride?: string }) => void;
        };
        const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
        await act(async () => {
            props.onAttachmentsAdded([file]);
            // Sending in the same turn proves the process-local attachment
            // owner, rather than a later React render, owns admission state.
            props.onSend({ inputTextOverride: 'Inspect the final edit' });
            await flushHookEffects({ cycles: 4, turns: 2 });
        });

        expect(sessionAttachmentsUploadFileSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1',
            sessionTarget: {
                serverId: 'server-1',
                accountId: 'account-1',
                sessionId: 's1',
            },
            messageLocalId: 'first-input-1',
            file: expect.objectContaining({ kind: 'web', file }),
        }));
        expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
            's1',
            expect.stringContaining('.happier/uploads/messages/first-input-1/notes.txt'),
            'Inspect the final edit',
            expect.objectContaining({
                happier: expect.objectContaining({ kind: 'attachments.v1' }),
            }),
            expect.objectContaining({
                serverId: 'server-1',
                localId: 'first-input-1',
                recipient: { kind: 'execution_run', runId: 'run_1' },
            }),
        );
    });

    it('hands a post-capture edit to the known Run document after a delayed upload admits the captured input', async () => {
        const upload = createDeferred<{
            success: true;
            path: string;
            sizeBytes: number;
            sha256: string;
        }>();
        sessionAttachmentsUploadFileSpy.mockReturnValueOnce(upload.promise);
        const runOwner: { current: MutableComposerDocumentOwner | null } = { current: null };
        let admittedDraft: ParticipantComposerPreparedSubmission['draft'] | null = null;
        const submitPreparedMessage = vi.fn(async (submission: ParticipantComposerPreparedSubmission) => {
            admittedDraft = submission.draft;
            const destination = createEphemeralComposerDocumentOwner({
                ref: { kind: 'participantMessage', sessionId: 's1', instanceId: 'run-1' },
                capabilities: { text: true, references: true, attachments: true, submit: true },
                initialDocument: {
                    text: submission.draft.text,
                    structuredInputMentions: submission.draft.mentions,
                    composerAttachments: submission.draft.attachments,
                },
            });
            const destinationAcceptedCurrentness = destination.captureCurrentness();
            const residual = submission.onOutboundHandoff();
            promoteAcceptedComposerDocument({
                residual: {
                    text: residual.text,
                    structuredInputMentions: residual.mentions,
                    composerAttachments: residual.attachments,
                },
                destination,
                destinationAcceptedCurrentness,
            });
            runOwner.current = destination;
        });
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            serverId="server-1"
            canSendMessages
            recipient={null}
            initialLocalId="first-input-1"
            draftOccurrenceId="rowless-draft-1"
            submitPreparedMessage={submitPreparedMessage}
        />);

        let input = agentInputSpy.mock.lastCall?.[0] as {
            onAttachmentsAdded: (files: readonly File[]) => void;
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            input.onAttachmentsAdded([new File(['hello'], 'notes.txt', { type: 'text/plain' })]);
            input.onChangeText('A');
        });
        input = agentInputSpy.mock.lastCall?.[0] as typeof input;
        act(() => input.onSend());
        await act(async () => {
            await Promise.resolve();
        });
        expect(submitPreparedMessage).not.toHaveBeenCalled();

        input = agentInputSpy.mock.lastCall?.[0] as typeof input;
        await act(async () => {
            input.onChangeText('B');
        });
        upload.resolve({
            success: true,
            path: '.happier/uploads/messages/first-input-1/notes.txt',
            sizeBytes: 5,
            sha256: 'sha-notes',
        });
        await act(async () => {
            await flushHookEffects({ cycles: 4, turns: 2 });
        });

        expect(admittedDraft).toMatchObject({ text: 'A' });
        expect(runOwner.current?.read().document.text).toBe('B');
        expect(readComposerPresentationSnapshot(participantComposerRef)?.text).toBe('B');
    });

    it('rehydrates process-local file drafts instead of carrying them across an Account switch', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');
        const accountOneScope = {
            serverId: 'server-1',
            accountId: 'account-1',
            sessionId: 's1',
            occurrenceId: 'run-draft-1',
        } as const;
        const accountTwoScope = { ...accountOneScope, accountId: 'account-2' } as const;
        clearSessionAttachmentDrafts(accountOneScope);
        clearSessionAttachmentDrafts(accountTwoScope);

        const screen = await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            serverId="server-1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            initialLocalId="first-input-1"
            draftOccurrenceId="run-draft-1"
        />);
        const { SessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/SessionTranscriptSourceContext');
        expect(screen.findAllByType(SessionTranscriptSourceProvider).map((root) => root.props.source)).toEqual([
            expect.objectContaining({ kind: 'app', sessionId: 's1', serverId: 'server-1' }),
        ]);
        const firstProps = agentInputSpy.mock.lastCall?.[0] as {
            onAttachmentsAdded: (files: readonly File[]) => void;
        };
        const file = new File(['private account bytes'], 'private.txt', { type: 'text/plain' });
        await act(async () => {
            firstProps.onAttachmentsAdded([file]);
            await flushHookEffects({ cycles: 3, turns: 1 });
        });
        expect(readSessionAttachmentDrafts(accountOneScope)).toHaveLength(1);

        participantAccountBindingState.accountId = 'account-2';
        await screen.update(<SessionParticipantComposer
            sessionId="s1"
            serverId="server-1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            initialLocalId="first-input-1"
            draftOccurrenceId="run-draft-1"
        />);
        await flushHookEffects({ cycles: 3, turns: 1 });

        expect(readSessionAttachmentDrafts(accountOneScope)).toHaveLength(1);
        expect(readSessionAttachmentDrafts(accountTwoScope)).toEqual([]);
        const secondProps = agentInputSpy.mock.lastCall?.[0] as {
            attachmentRowItems?: readonly unknown[];
        };
        expect(secondProps.attachmentRowItems ?? []).toEqual([]);
        clearSessionAttachmentDrafts(accountOneScope);
        clearSessionAttachmentDrafts(accountTwoScope);
    });

    it('carries staged transfer drafts and unsent text into a new draft occurrence for the same Session', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');
        const firstOccurrence = {
            serverId: 'server-1',
            accountId: 'account-1',
            sessionId: 's1',
            occurrenceId: 'draft-occurrence-1',
        } as const;
        const secondOccurrence = { ...firstOccurrence, occurrenceId: 'draft-occurrence-2' } as const;
        clearSessionAttachmentDrafts(firstOccurrence);
        clearSessionAttachmentDrafts(secondOccurrence);

        const screen = await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            serverId="server-1"
            canSendMessages
            recipient={null}
            initialLocalId="first-input-1"
            draftOccurrenceId="draft-occurrence-1"
        />);
        let composerProps = agentInputSpy.mock.lastCall?.[0] as {
            onAttachmentsAdded: (files: readonly File[]) => void;
            onChangeText: (text: string) => void;
        };
        await act(async () => {
            composerProps.onChangeText('Still unsent');
        });
        composerProps = agentInputSpy.mock.lastCall?.[0] as typeof composerProps;
        await act(async () => {
            composerProps.onAttachmentsAdded([new File(['notes'], 'notes.txt', { type: 'text/plain' })]);
            await flushHookEffects({ cycles: 3, turns: 1 });
        });
        expect(readSessionAttachmentDrafts(firstOccurrence)).toHaveLength(1);

        await screen.update(<SessionParticipantComposer
            sessionId="s1"
            serverId="server-1"
            canSendMessages
            recipient={null}
            initialLocalId="first-input-1"
            draftOccurrenceId="draft-occurrence-2"
        />);
        await flushHookEffects({ cycles: 3, turns: 1 });

        // A launcher starting another attempt rotates the draft occurrence. The unsent
        // text and staged file belong to the person, not to the abandoned attempt, and
        // the abandoned occurrence keeps no copy of those process-local bytes.
        const carriedProps = agentInputSpy.mock.lastCall?.[0] as {
            attachmentRowItems?: readonly unknown[];
            value?: string;
        };
        expect(carriedProps.value).toBe('Still unsent');
        expect(carriedProps.attachmentRowItems ?? []).toHaveLength(1);
        expect(readSessionAttachmentDrafts(secondOccurrence)).toHaveLength(1);
        expect(readSessionAttachmentDrafts(firstOccurrence)).toEqual([]);
        clearSessionAttachmentDrafts(firstOccurrence);
        clearSessionAttachmentDrafts(secondOccurrence);
    });

    it('reuses the mounted draft identity across an outcome-unknown retry', async () => {
        syncSubmitMessageSpy
            .mockRejectedValueOnce(new Error('admission outcome unknown'))
            .mockImplementationOnce(async (_sessionId, _text, _displayText, _meta, options) => {
                options?.onOutboundHandoff?.({ persistence: 'pending', localId: 'first-input-1' });
            });
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            initialLocalId="first-input-1"
        />);

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('Retry this exact input');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as typeof agentInputProps;
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as typeof agentInputProps;
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(syncSubmitMessageSpy).toHaveBeenCalledTimes(2);
        expect(syncSubmitMessageSpy.mock.calls.map((call) => call[4]?.localId)).toEqual([
            'first-input-1',
            'first-input-1',
        ]);
    });

    it('normalizes the legacy steer_if_supported selection to the canonical steer_if_active action', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            executionRunRequestedAction={{ v: 1, kind: 'steer_if_active' }}
        />);

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('Steer the run');
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
            'Steer the run',
            undefined,
            expect.anything(),
            expect.objectContaining({
                requestedAction: { v: 1, kind: 'steer_if_active' },
            }),
        );
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

    it('admits contributed drops on a presented participant without input focus and retires hidden hosts', async () => {
        const daemon = currentParticipantDaemonProjection({ [issueAttachmentCatalogEntry.id]: issueAttachmentCatalogEntry });
        const introspection = daemon.inputs.pluginProjectionV2.contributionIntrospection!;
        participantDaemonProjectionState.current = { ...daemon, inputs: { ...daemon.inputs, pluginProjectionV2: {
            ...daemon.inputs.pluginProjectionV2, contributionIntrospection: { ...introspection,
                contributions: introspection.contributions.map(record => ({ ...record, occurrenceId: '7' })),
            },
        } } };
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { resolveComposerEntityDrop } = await import('@/components/sessions/composer/composerEntityDrop');
        const { buildComposerReferenceMentionPayloadV1 } = await import('@happier-dev/protocol');
        const render = (presented: boolean) => <PluginSurfaceFocusEligibilityProvider active={false} presentationActive={presented}>
            <SessionParticipantComposer sessionId="s1" canSendMessages recipient={null} />
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(render(true));
        const input = agentInputSpy.mock.lastCall?.[0] as React.ComponentProps<typeof import('@/components/sessions/agentInput').AgentInput>;
        if (!input.composerRef) throw new Error('Expected participant composer identity');
        const scope = { serverId: 'server-1', accountId: 'account-1' };
        const item = { kind: 'plugin' as const, scope, contribution: { pluginId: 'acme.issues', localId: 'issue-drag' },
            reference: buildComposerReferenceMentionPayloadV1({ reference: { pluginId: 'acme.issues', localId: 'issues' },
                candidate: { id: 'issue-42', label: 'Issue #42' } }),
        };
        const context = { scope, ref: input.composerRef, snapshot: readComposerPresentationSnapshot(input.composerRef),
            workspace: null, sessions: [], referenceHost: input.composerReferenceHost,
            preview: { verb: 'Reference', target: 'Participant' }, reason: (code: string) => code,
        };
        expect(context.snapshot?.state.focused).toBe(false);
        expect(resolveComposerEntityDrop(item, context).status).toBe('allowed');
        await act(async () => { screen.tree.update(render(false)); });
        expect(resolveComposerEntityDrop(item, context).status).toBe('refused');
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
                expectedOccurrenceId: '7',
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
                    occurrenceId: 'issues-generation-1',
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
                    occurrenceId: 'issues-generation-1',
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
            occurrenceId: 'issues-generation-2',
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
                occurrenceId: 'issues-generation-3',
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
                occurrenceId: 'generation-1',
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
                occurrenceId: 'generation-1',
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

    it('presents a coded target-admission rejection as localized copy, never as the raw protocol code', async () => {
        syncSubmitMessageSpy.mockRejectedValueOnce(Object.assign(
            new Error('session_input_target_unavailable'),
            { code: 'session_input_target_unavailable' },
        ));
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
        />);

        await seedParticipantComposerSemanticSnapshot();
        const agentInputProps = agentInputSpy.mock.lastCall?.[0] as { onSend: () => void };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'session.pendingMessages.admissionRejected.targetUnavailable');
        expect(modalAlertSpy).not.toHaveBeenCalledWith('common.error', 'session_input_target_unavailable');
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
                    occurrenceId: 'issues-generation-1',
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
            onStructuredInputMentionsChange: (mentions: readonly Record<string, unknown>[]) => void;
            structuredInputMentions?: readonly Record<string, unknown>[];
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
        const retainedMention = agentInputProps.structuredInputMentions?.[0];
        if (!retainedMention) throw new Error('expected controlled participant mention');
        await act(async () => {
            agentInputProps.onChangeText('Newer participant @issue');
        });
        expect(readComposerPresentationSnapshot(ref)?.references).toEqual([
            expect.objectContaining({ ref: 'partner:issue-42', token: '@issue', start: 18, end: 24 }),
        ]);
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

    it('clears text-bound newer participant references atomically with unchanged accepted text', async () => {
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
        expect(readComposerPresentationSnapshot(participantComposerRef)).toMatchObject({
            text: 'Captured participant @issue @new',
            references: [
                expect.objectContaining({ ref: 'partner:issue-42', token: '@issue' }),
                expect.objectContaining({ ref: 'partner:issue-99', token: '@new' }),
            ],
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
                    occurrenceId: 'issues-generation-1',
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

    it('carries composer attachments into an execution-run send instead of rejecting them', async () => {
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
                    occurrenceId: 'issues-generation-1',
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

        // A Run attachment belongs to the parent Session's media domain exactly like a
        // main-Session one; only the destination differs. The old direct send had no
        // metadata channel and had to refuse it.
        expect(sessionExecutionRunSendSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
            's1',
            expect.any(String),
            undefined,
            expect.objectContaining({
                happierStructuredInputV1: expect.objectContaining({
                    composerAttachments: [expect.objectContaining({
                        attachment: { pluginId: 'acme.issues', localId: 'issue' },
                        key: '42',
                    })],
                }),
            }),
            expect.objectContaining({
                recipient: { kind: 'execution_run', runId: 'run_1' },
            }),
        );
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

    it('carries attached browser context into an execution-run send through the same metadata channel as the main Session', async () => {
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
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(syncSubmitMessageSpy).toHaveBeenCalledWith(
            's1',
            'Use the browser page',
            undefined,
            expect.objectContaining({
                happierBrowserContext: expect.objectContaining({
                    kind: 'browser_context.v1',
                }),
            }),
            expect.objectContaining({
                recipient: { kind: 'execution_run', runId: 'run_1' },
            }),
        );
    });

    it('still refuses an execution-run send whose attached browser context has gone stale', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            browserContextState={createAttachedBrowserContextState({ stale: true })}
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

        expect(syncSubmitMessageSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'browserContext.composer.contextUnavailable');
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
            extraActionChips: expect.arrayContaining(extraActionChips),
        }));
    });

    it('passes the participant Session exact qualified address to Voice authoring', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        await renderScreen(<SessionParticipantComposer
            sessionId="shared-session"
            serverId="server-b"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
        />);

        expect(agentInputSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionAddress: { serverId: 'server-b', sessionId: 'shared-session' },
        }));
    });
});
