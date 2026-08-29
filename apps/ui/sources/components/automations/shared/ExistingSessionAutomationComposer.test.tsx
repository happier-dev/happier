import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExistingSessionAutomationAvailability } from '@/sync/domains/automations/existingSessionAutomationAvailability';
import { buildExistingSessionAutomationAuthoringContext } from '@/components/sessions/authoring/context/buildExistingSessionAutomationAuthoringContext';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import { renderScreen } from '@/dev/testkit';
import {
    applyComposerPresentationTransaction,
    createComposerPresentationHostHandlers,
    readComposerPresentationSnapshot,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import type {
    DaemonPluginUiComposerSurfaceCatalogEntryV1,
    PluginProjectionV2,
    PluginProjectedComposerRegionEntryV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const randomUUIDSpy = vi.hoisted(() => vi.fn(() => 'automation-composer-scope'));
const modalAlertSpy = vi.hoisted(() => vi.fn((_title?: string, _message?: string) => {}));
const agentInputSpy = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeSpy = vi.hoisted(() => vi.fn<
    (params: unknown) => Promise<unknown>
>(async () => ({})));
const automationDaemonProjectionState = vi.hoisted(() => ({ current: null as unknown }));
const pluginSurfaceHostSpy = vi.hoisted(() => vi.fn());

const automationRegion = {
    id: 'acme.automations/automation-region',
    pluginId: 'acme.automations',
    identity: { pluginId: 'acme.automations', localId: 'automation-region' },
    immutableGenerationId: 'automations-generation-1',
    definition: {
        id: 'automation-region',
        placement: 'afterComposer',
        renderer: { renderer: 'automation-region-renderer' },
        scopes: ['automationAuthoring'],
    },
} satisfies PluginProjectedComposerRegionEntryV1;

function createAutomationComposerCatalogEntry(): DaemonPluginUiComposerSurfaceCatalogEntryV1 {
    return {
        contribution: automationRegion.identity,
        immutableGenerationId: automationRegion.immutableGenerationId,
        projectionGeneration: 9,
        role: 'region',
        rendererChain: [{ pluginId: 'acme.automations', localId: 'automation-region-renderer' }],
        selectedRenderer: {
            identity: { pluginId: 'acme.automations', localId: 'automation-region-renderer' },
            renderer: {
                kind: 'declarative',
                contributionId: 'automation-region-renderer',
                model: { visible: true },
            },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        },
        executionOrigin: {
            serverIdentityId: 'server-1',
            materializationRef: {
                machineId: 'machine-1',
                materializationId: 'automations-materialization-1',
                pluginId: 'acme.automations',
            },
        },
        resourceCapability: { readable: true, dynamic: true },
        contributorTargetedContributions: {
            target: { pluginId: 'acme.automations', immutableGenerationId: 'automations-generation-1' },
            points: [],
        },
    } as DaemonPluginUiComposerSurfaceCatalogEntryV1;
}

function currentAutomationDaemonProjection() {
    const pluginProjectionV2: PluginProjectionV2 = {
        v: 2,
        generation: 9,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            composerRegions: {
                family: 'composerRegions',
                entriesById: { [automationRegion.id]: automationRegion },
            },
        },
        contributionIntrospection: {
            version: 1,
            generation: 9,
            contributions: [{
                version: 1,
                contribution: {
                    kind: 'localId',
                    pluginId: 'acme.automations',
                    family: 'composerReferences',
                    qualifiedId: 'acme.automations/issues',
                    localId: 'issues',
                },
                progression: { declared: true, normalized: true, merged: true },
                registration: { requirement: 'required', state: 'bound', generation: '9' },
                activation: { state: 'active', generation: '9' },
                projection: { state: 'projected' },
                presentation: {
                    kind: 'composerReference',
                    title: 'Automation issues',
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
            composerSurfaceCatalog: [createAutomationComposerCatalogEntry()],
        },
    };
}

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => randomUUIDSpy(),
}));

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: unknown) => {
        agentInputSpy(props);
        return React.createElement('AgentInput', props as Record<string, unknown>);
    },
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
    useDaemonMergedProjectionInputs: () => automationDaemonProjectionState.current,
}));
vi.mock('@/components/plugins/surfaces/PluginSurfaceHost', () => ({
    PluginSurfaceHost: (props: Record<string, unknown>) => {
        pluginSurfaceHostSpy(props);
        return React.createElement('PluginSurfaceHost', props);
    },
}));
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

vi.mock('@/text', () => ({
    t: (key: string) => key,
    tLoose: (key: string) => key,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: modalAlertSpy } }).module;
});

const DRAFT = {
    targetType: 'existing_session',
    executionTarget: null,
    directory: '/repo/project',
    checkoutCreationDraft: null,
    organizationPlacement: { folderId: null, tagIds: [] },
    prompt: 'Summarize the latest changes',
    displayText: 'Summarize the latest changes',
    agentTarget: null,
    transcriptStorage: 'direct',
    profileId: null,
    environmentVariables: null,
    resumeSessionId: null,
    permissionMode: 'default',
    permissionModeUpdatedAt: null,
    modelSelection: null,
    mcpSelection: null,
    connectedServices: {
        v: 1,
        bindingsByServiceId: {},
    },
    terminal: null,
    windowsRemoteSessionLaunchMode: null,
    windowsRemoteSessionConsole: null,
    windowsTerminalWindowName: null,
    runtimeDescriptorV1: null,
    acpSessionModeId: null,
    sessionConfigOptionOverrides: null,
    existingSessionId: 's1',
    sessionEncryptionMode: 'plain',
    sessionEncryptionKeyBase64: null,
    sessionEncryptionVariant: null,
    automation: {
        enabled: true,
        name: 'Nightly summary',
        description: 'Summarize the latest state',
        triggers: [{
            clientId: 'schedule-hourly',
            definition: {
                kind: 'schedule',
                enabled: true,
                schedule: {
                    kind: 'interval',
                    everyMs: 60 * 60_000,
                    scheduleExpr: null,
                    timezone: null,
                },
            },
        }],
    },
} satisfies SessionAuthoringDraft;

const READY_AVAILABILITY = {
    kind: 'ready',
    machineId: 'machine-1',
    eligibility: {
        eligible: true,
        strategy: 'happy_attach',
        compatBackendId: 'review-bot',
    },
} satisfies ExistingSessionAutomationAvailability;

function createContext(sessionId = 's1') {
    return buildExistingSessionAutomationAuthoringContext({
        session: {
            id: sessionId,
            encryptionMode: 'plain',
            metadata: {
                path: '/repo/project',
                host: 'qa-host',
                profileId: null,
                flavor: null,
                machineId: 'machine-1',
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {},
                },
            },
            permissionMode: 'default',
            permissionModeUpdatedAt: null,
            modelMode: 'default',
            modelModeUpdatedAt: null,
        },
        draft: {
            ...DRAFT,
            existingSessionId: sessionId,
        },
        availability: READY_AVAILABILITY,
    });
}

describe('ExistingSessionAutomationComposer', () => {
    beforeEach(() => {
        agentInputSpy.mockClear();
        machineRpcWithServerScopeSpy.mockReset();
        machineRpcWithServerScopeSpy.mockResolvedValue({});
        pluginSurfaceHostSpy.mockClear();
        modalAlertSpy.mockClear();
        automationDaemonProjectionState.current = currentAutomationDaemonProjection();
    });

    it('commits text and opaque references through the incumbent automation draft owner', async () => {
        const { ExistingSessionAutomationComposer } = await import('./ExistingSessionAutomationComposer');
        const onChangeDraft = vi.fn();

        await renderScreen(<ExistingSessionAutomationComposer
            context={createContext()}
            onChangeDraft={onChangeDraft}
            onSubmit={() => {}}
            submitAccessibilityLabel="Save"
            isSubmitDisabled={false}
        />);

        const agentInputProps = agentInputSpy.mock.lastCall?.[0] as Readonly<{
            onPermissionModeChange?: unknown;
            onModelModeChange?: unknown;
        }>;
        expect(agentInputProps.onPermissionModeChange).toBeUndefined();
        expect(agentInputProps.onModelModeChange).toBeUndefined();

        const ref = {
            kind: 'automationAuthoring' as const,
            sessionId: 's1',
            instanceId: 'automation-composer-scope',
        };
        const initial = readComposerPresentationSnapshot(ref);
        expect(initial).not.toBeNull();
        if (!initial) throw new Error('expected mounted automation composer target');

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
            })).toEqual({ status: 'applied', revision: initial.revision + 1 });
        });

        expect(readComposerPresentationSnapshot(ref)).toMatchObject({
            text: 'Review @issue',
            references: [{
                kind: 'partner.reference',
                ref: 'partner:issue-42',
                token: '@issue',
                start: 7,
                end: 13,
                label: 'Issue #42',
            }],
            attachments: [],
        });
        const updateDraft = onChangeDraft.mock.calls[0]?.[0] as ((draft: SessionAuthoringDraft | null) => SessionAuthoringDraft | null) | undefined;
        expect(updateDraft?.(DRAFT)).toMatchObject({
            prompt: 'Review @issue',
            displayText: 'Review @issue',
        });
    });

    it('refuses a submit carrying a reference the rendered Automation prompt cannot express', async () => {
        const { ExistingSessionAutomationComposer } = await import('./ExistingSessionAutomationComposer');
        const onSubmit = vi.fn();

        await renderScreen(<ExistingSessionAutomationComposer
            context={createContext()}
            onChangeDraft={vi.fn()}
            onSubmit={onSubmit}
            submitAccessibilityLabel="Save"
            isSubmitDisabled={false}
        />);

        const ref = {
            kind: 'automationAuthoring' as const,
            sessionId: 's1',
            instanceId: 'automation-composer-scope',
        };
        const initial = readComposerPresentationSnapshot(ref);
        if (!initial) throw new Error('expected mounted automation composer target');

        await act(async () => {
            expect(applyComposerPresentationTransaction({
                ref,
                transaction: {
                    expectedRevision: initial.revision,
                    operations: [
                        { kind: 'text.set', text: 'Continue @Nightly audit' },
                        {
                            kind: 'reference.insert',
                            reference: {
                                kind: 'happier.session',
                                ref: 'session:sess_01HZX',
                                token: '@Nightly audit',
                                start: 9,
                                end: 23,
                                label: 'Nightly audit',
                            },
                        },
                    ],
                },
            })).toMatchObject({ status: 'applied' });
        });

        const send = agentInputSpy.mock.calls.at(-1)?.[0] as Readonly<{ onSend: () => void }>;
        act(() => { send.onSend(); });

        // The V2 Automation template stores the rendered program alone, so a
        // Session pick would become a look-alike token: the writer refuses it
        // instead of persisting an Automation that silently loses the identity.
        expect(onSubmit).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'automations.unsupportedReference');
    });

    it('submits a file mention whose rendered token already carries its path', async () => {
        const { ExistingSessionAutomationComposer } = await import('./ExistingSessionAutomationComposer');
        const onSubmit = vi.fn();

        await renderScreen(<ExistingSessionAutomationComposer
            context={createContext()}
            onChangeDraft={vi.fn()}
            onSubmit={onSubmit}
            submitAccessibilityLabel="Save"
            isSubmitDisabled={false}
        />);

        const ref = {
            kind: 'automationAuthoring' as const,
            sessionId: 's1',
            instanceId: 'automation-composer-scope',
        };
        const initial = readComposerPresentationSnapshot(ref);
        if (!initial) throw new Error('expected mounted automation composer target');

        await act(async () => {
            expect(applyComposerPresentationTransaction({
                ref,
                transaction: {
                    expectedRevision: initial.revision,
                    operations: [
                        { kind: 'text.set', text: 'Review @docs/README.md every morning' },
                        {
                            kind: 'reference.insert',
                            reference: {
                                kind: 'happier.file',
                                ref: 'file:docs/README.md',
                                token: '@docs/README.md',
                                start: 7,
                                end: 22,
                                label: 'README.md',
                            },
                        },
                    ],
                },
            })).toMatchObject({ status: 'applied' });
        });

        const send = agentInputSpy.mock.calls.at(-1)?.[0] as Readonly<{ onSend: () => void }>;
        act(() => { send.onSend(); });

        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('projects the mounted action-bar layout through the automation Composer snapshot', async () => {
        const { ExistingSessionAutomationComposer } = await import('./ExistingSessionAutomationComposer');

        await renderScreen(<ExistingSessionAutomationComposer
            context={createContext()}
            onChangeDraft={() => {}}
            onSubmit={() => {}}
            submitAccessibilityLabel="Save"
            isSubmitDisabled={false}
        />);

        const composerRef = {
            kind: 'automationAuthoring' as const,
            sessionId: 's1',
            instanceId: 'automation-composer-scope',
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

    it('registers an exact automation scope that rejects attachment mutations without changing the draft', async () => {
        const { ExistingSessionAutomationComposer } = await import('./ExistingSessionAutomationComposer');
        const onChangeDraft = vi.fn();

        await renderScreen(<ExistingSessionAutomationComposer
            context={createContext()}
            onChangeDraft={onChangeDraft}
            onSubmit={() => {}}
            submitAccessibilityLabel="Save"
            isSubmitDisabled={false}
        />);

        const ref = {
            kind: 'automationAuthoring' as const,
            sessionId: 's1',
            instanceId: 'automation-composer-scope',
        };
        const initial = readComposerPresentationSnapshot(ref);
        expect(initial).toMatchObject({
            ref,
            text: DRAFT.prompt,
            attachments: [],
            capabilities: {
                text: true,
                references: true,
                attachments: false,
                submit: false,
            },
        });
        expect(initial).not.toBeNull();
        if (!initial) throw new Error('expected mounted automation composer target');

        await act(async () => {
            expect(applyComposerPresentationTransaction({
                ref,
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
            })).toEqual({
                status: 'invalidOperation',
                operationIndex: 0,
                reason: 'attachments_unsupported',
            });
        });

        expect(onChangeDraft).not.toHaveBeenCalled();
    });

    it('mounts automation regions through the shared host on the owned Session target', async () => {
        const { ExistingSessionAutomationComposer } = await import('./ExistingSessionAutomationComposer');

        await renderScreen(<ExistingSessionAutomationComposer
            context={createContext()}
            onChangeDraft={() => {}}
            onSubmit={() => {}}
            submitAccessibilityLabel="Save"
            isSubmitDisabled={false}
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
                                kind: 'automationAuthoring',
                                sessionId: 's1',
                                instanceId: 'automation-composer-scope',
                            },
                        }),
                    }),
                }),
            }),
        }));
    });

    it('shows provider rows only through the current focused automation scope', async () => {
        const { ExistingSessionAutomationComposer } = await import('./ExistingSessionAutomationComposer');
        const screen = await renderScreen(<ExistingSessionAutomationComposer
            context={createContext('s1')}
            onChangeDraft={() => {}}
            onSubmit={() => {}}
            submitAccessibilityLabel="Save"
            isSubmitDisabled={false}
        />);

        type AutomationAutocompleteProps = Readonly<{
            autocompleteKinds: readonly string[];
            autocompleteSuggestions: (query: string, signal: AbortSignal) => Promise<unknown>;
            onComposerFocusChange: (focused: boolean) => void;
        }>;
        let firstProps = agentInputSpy.mock.lastCall?.[0] as AutomationAutocompleteProps;
        expect(firstProps.autocompleteKinds).toEqual([
            'file',
            'vendorPlugin',
            'composerReference',
            'slashCommand',
        ]);
        machineRpcWithServerScopeSpy
            .mockResolvedValueOnce({
                ok: true,
                reference: { pluginId: 'acme.automations', localId: 'issues' },
                page: [{ id: 'automation-42', label: 'Automation issue #42' }],
            })
            .mockResolvedValueOnce({
                ok: true,
                reference: { pluginId: 'acme.automations', localId: 'issues' },
                page: [{ id: 'automation-99', label: 'Automation issue #99' }],
            });
        await act(async () => {
            firstProps.onComposerFocusChange(true);
            const suggestions = await firstProps.autocompleteSuggestions('@issue', new AbortController().signal);
            expect(suggestions).toEqual([
                expect.objectContaining({
                    kind: 'composerReference',
                    label: 'Automation issue #42',
                }),
            ]);
        });
        expect(machineRpcWithServerScopeSpy).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            method: RPC_METHODS.DAEMON_PLUGIN_COMPOSER_REFERENCE_SEARCH,
            payload: expect.objectContaining({
                expectedGeneration: '9',
                reference: { pluginId: 'acme.automations', localId: 'issues' },
                trigger: '@',
                query: 'issue',
            }),
            signal: expect.any(AbortSignal),
        }));

        await act(async () => {
            screen.tree.update(<ExistingSessionAutomationComposer
                context={createContext('s2')}
                onChangeDraft={() => {}}
                onSubmit={() => {}}
                submitAccessibilityLabel="Save"
                isSubmitDisabled={false}
            />);
        });
        const callsBeforeStaleSearch = machineRpcWithServerScopeSpy.mock.calls.length;
        await act(async () => {
            await expect(firstProps.autocompleteSuggestions('@issue', new AbortController().signal)).resolves.toEqual([]);
        });
        expect(machineRpcWithServerScopeSpy).toHaveBeenCalledTimes(callsBeforeStaleSearch);

        const secondProps = agentInputSpy.mock.lastCall?.[0] as AutomationAutocompleteProps;
        await act(async () => {
            secondProps.onComposerFocusChange(true);
            const suggestions = await secondProps.autocompleteSuggestions('@issue', new AbortController().signal);
            expect(suggestions).toEqual([
                expect.objectContaining({
                    kind: 'composerReference',
                    label: 'Automation issue #99',
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

    it('projects decorations and edit locks into the mounted automation input', async () => {
        const { ExistingSessionAutomationComposer } = await import('./ExistingSessionAutomationComposer');

        await renderScreen(<ExistingSessionAutomationComposer
            context={createContext()}
            onChangeDraft={() => {}}
            onSubmit={() => {}}
            submitAccessibilityLabel="Save"
            isSubmitDisabled={false}
        />);

        const ref = {
            kind: 'automationAuthoring' as const,
            sessionId: 's1',
            instanceId: 'automation-composer-scope',
        };
        const snapshot = readComposerPresentationSnapshot(ref);
        expect(snapshot).not.toBeNull();
        if (!snapshot) throw new Error('expected mounted automation composer target');
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
                key: 'automation-review',
                decorations: {
                    revision: snapshot.revision,
                    ranges: [{ range: { start: 0, end: 0 }, treatment: 'success' }],
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
            expect.objectContaining({ key: 'automation-review' }),
        ]);

        await act(async () => {
            expect(handlers.acquireComposerInputLock!(request('acquireComposerInputLock', {
                subscriptionId: 'lock-1',
                ref,
                request: { reason: 'Saving automation', mode: 'editAndSubmit' },
            }))).toBeNull();
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as typeof agentInputProps;
        expect(agentInputProps.composerInputLock).toEqual({
            mode: 'editAndSubmit',
            reasons: ['Saving automation'],
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

    it('uses the mounted automation input for active and exact focus requests', async () => {
        const { ExistingSessionAutomationComposer } = await import('./ExistingSessionAutomationComposer');
        const focus = vi.fn();

        await renderScreen(<ExistingSessionAutomationComposer
            context={createContext()}
            onChangeDraft={() => {}}
            onSubmit={() => {}}
            submitAccessibilityLabel="Save"
            isSubmitDisabled={false}
        />);

        const ref = {
            kind: 'automationAuthoring' as const,
            sessionId: 's1',
            instanceId: 'automation-composer-scope',
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
});
