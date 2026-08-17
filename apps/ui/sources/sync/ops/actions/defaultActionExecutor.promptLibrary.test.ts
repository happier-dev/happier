import { beforeEach, describe, expect, it, vi } from 'vitest';

const capturedDeps = vi.hoisted<{ current: any | null }>(() => ({ current: null }));
const writePromptLibraryArtifactToExternalAssetMock = vi.hoisted(() => vi.fn(async () => ({
    ok: true as const,
    nextPromptExternalLinks: { v: 1 as const, links: [] },
})));
const installPromptRegistryItemMock = vi.hoisted(() => vi.fn(async () => ({
    ok: true as const,
    artifactId: 'bundle-1',
    exported: true,
    routeKind: 'bundle' as const,
})));
const applySettingsLocalMock = vi.hoisted(() => vi.fn());
const updateArtifactWithHeaderMock = vi.hoisted(() => vi.fn(async () => {}));
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const sessionRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const patchSessionMetadataWithRetryMock = vi.hoisted(() => vi.fn());
const storageState = vi.hoisted<{ current: any }>(() => ({
    current: {
        settings: {
            promptExternalLinksV1: { v: 1, links: [] },
        },
        sessions: {},
    },
}));

vi.mock('@happier-dev/protocol', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        createActionExecutor: (deps: unknown) => {
            capturedDeps.current = deps;
            return { execute: vi.fn() };
        },
        isActionEnabledByActionsSettings: () => true,
    };
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
        getState: () => storageState.current,
    },
});
});

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunAction: vi.fn(),
    sessionExecutionRunGet: vi.fn(),
    sessionExecutionRunList: vi.fn(),
    sessionExecutionRunSend: vi.fn(),
    sessionExecutionRunStart: vi.fn(),
    sessionExecutionRunStop: vi.fn(),
}));

vi.mock('@/sync/ops/sessions', () => ({
    forkSession: vi.fn(),
    rollbackSessionConversation: vi.fn(),
    sessionRename: vi.fn(async () => ({ success: true })),
}));
vi.mock('@/sync/ops/sessionHandoffs', () => ({ completeSessionHandoff: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({ sessionRpcWithServerScope: sessionRpcWithServerScopeMock }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage', () => ({ sendSessionMessageWithServerScope: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpcWithServerScopeMock }));
vi.mock('@/voice/session/voiceSession', () => ({ voiceSessionManager: { stop: vi.fn() } }));
vi.mock('@/voice/agent/voiceAgentGlobalSessionId', () => ({ VOICE_AGENT_GLOBAL_SESSION_ID: 'voice-global' }));
vi.mock('@/voice/agent/teleportVoiceAgentToSessionRoot', () => ({ teleportVoiceAgentToSessionRoot: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/openSession', () => ({ openSessionForVoiceTool: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/sessionTargets', () => ({ setPrimaryActionSessionId: vi.fn(), setTrackedSessionIds: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/sessionList', () => ({ listSessionsForVoiceTool: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/sessionActivity', () => ({ getSessionActivityForVoiceTool: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/sessionRecentMessages', () => ({
    getSessionRecentMessagesForVoiceTool: vi.fn(),
    getSessionTranscriptForVoiceTool: vi.fn(),
}));
vi.mock('@/voice/tools/actionImpl/pathsListRecent', () => ({ listRecentPathsForVoiceTool: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/machinesList', () => ({ listMachinesForVoiceTool: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/serversList', () => ({ listServersForVoiceTool: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/reviewEnginesList', () => ({ listReviewEnginesForVoiceTool: vi.fn() }));
vi.mock('@/voice/tools/actionImpl/agentCatalogList', () => ({
    listAgentBackendsForVoiceTool: vi.fn(),
    listAgentModelsForVoiceTool: vi.fn(),
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        createArtifactWithHeader: vi.fn(),
        fetchArtifactWithBody: vi.fn(),
        patchSessionMetadataWithRetry: patchSessionMetadataWithRetryMock,
        updateArtifactWithHeader: updateArtifactWithHeaderMock,
    },
}));
vi.mock('@/sync/state/acpSessionModeOverridePublish', () => ({ publishAcpSessionModeOverrideToMetadata: vi.fn() }));
vi.mock('@/sync/ops/promptLibrary/promptDocs', () => ({ updatePromptDoc: vi.fn() }));
vi.mock('@/sync/ops/promptLibrary/promptBundles', () => ({ updateSkillPromptBundle: vi.fn() }));
vi.mock('./sessionModeActionSupport', () => ({
    isRequestedSessionModeSupported: vi.fn(() => true),
    isSessionModeActionAvailable: vi.fn(() => true),
    normalizeRequestedSessionModeId: vi.fn((value) => value),
    resolveSessionModeActionControl: vi.fn(() => ({})),
    serializeSessionModeActionOptions: vi.fn(() => []),
}));

vi.mock('@/sync/ops/promptLibrary/exportPromptLibraryArtifact', () => ({
    writePromptLibraryArtifactToExternalAsset: writePromptLibraryArtifactToExternalAssetMock,
}));

vi.mock('@/sync/ops/promptLibrary/installPromptRegistryItem', () => ({
    installPromptRegistryItem: installPromptRegistryItemMock,
}));

describe('createDefaultActionExecutor (prompt library routing)', () => {
    beforeEach(() => {
        capturedDeps.current = null;
        writePromptLibraryArtifactToExternalAssetMock.mockClear();
        installPromptRegistryItemMock.mockClear();
        applySettingsLocalMock.mockClear();
        updateArtifactWithHeaderMock.mockClear();
        machineRpcWithServerScopeMock.mockReset();
        sessionRpcWithServerScopeMock.mockReset();
        patchSessionMetadataWithRetryMock.mockReset();
        storageState.current = {
            settings: {
                promptExternalLinksV1: { v: 1, links: [] },
            },
            applySettingsLocal: applySettingsLocalMock,
            sessions: {},
        };
        patchSessionMetadataWithRetryMock.mockImplementation(
            async (sessionId: string, updater: (metadata: any) => any) => {
                const session = storageState.current.sessions[sessionId];
                session.metadata = updater(session.metadata);
            },
        );
    });

    it('passes serverId through prompt asset export operations', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        createDefaultActionExecutor();

        await capturedDeps.current.promptAssetExport({
            artifactId: 'doc-1',
            machineId: 'machine-1',
            assetTypeId: 'claude.command',
            scope: 'user',
            targetPath: 'review.md',
            serverId: 'server-1',
        });

        expect(writePromptLibraryArtifactToExternalAssetMock).toHaveBeenCalledWith(expect.objectContaining({
            artifactId: 'doc-1',
            machineId: 'machine-1',
            assetTypeId: 'claude.command',
            scope: 'user',
            targetInput: 'review.md',
            serverId: 'server-1',
        }));
    });

    it('routes exact existing-session model selections to the session-host private transition owner', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const selection = {
            agentTargetKey: 'backend:claude',
            providerConnectionId: 'pc_work',
            modelId: 'provider-model',
        };
        const ownerUnavailable = {
            ok: false,
            status: 'owner_unavailable',
            activeSelection: {
                agentTargetKey: 'backend:claude',
                providerConnectionId: null,
                modelId: 'native-model',
            },
            requestedSelection: selection,
            reason: 'session_host_unavailable',
        };
        const ownerUnavailableActionFailure = {
            ok: false,
            errorCode: 'owner_unavailable',
            error: 'owner_unavailable',
            details: {
                status: 'owner_unavailable',
                activeSelection: ownerUnavailable.activeSelection,
                requestedSelection: selection,
                reason: 'session_host_unavailable',
            },
        };
        const nativeDefaultSelection = {
            agentTargetKey: 'backend:claude',
            providerConnectionId: null,
            modelId: 'default',
        };
        const nativeDefaultApplied = {
            ok: true,
            status: 'applied',
            activeSelection: nativeDefaultSelection,
        };
        const inheritedProviderSelection = {
            agentTargetKey: 'backend:claude',
            providerConnectionId: 'pc_active',
            modelId: 'provider-next',
        };
        const inheritedProviderApplied = {
            ok: true,
            status: 'applied',
            activeSelection: inheritedProviderSelection,
        };
        storageState.current = {
            settings: {
                promptExternalLinksV1: { v: 1, links: [] },
            },
            applySettingsLocal: applySettingsLocalMock,
            sessions: {
                session_1: {
                    active: true,
                    metadata: {
                        agent: 'claude',
                    },
                },
            },
        };
        sessionRpcWithServerScopeMock
            .mockResolvedValueOnce(ownerUnavailable)
            .mockResolvedValueOnce(nativeDefaultApplied)
            .mockResolvedValueOnce(inheritedProviderApplied);

        createDefaultActionExecutor();

        await expect(capturedDeps.current.sessionModelSet({
            sessionId: 'session_1',
            modelId: 'provider-model',
            providerConnectionId: 'pc_work',
            serverId: 'server_1',
        })).resolves.toEqual(ownerUnavailableActionFailure);
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session_1',
            serverId: 'server_1',
            method: 'session.model.transition',
            payload: {
                v: 1,
                selection,
            },
        });

        await expect(capturedDeps.current.sessionModelSet({
            sessionId: 'session_1',
            modelId: 'default',
            providerConnectionId: null,
        })).resolves.toEqual({
            ...nativeDefaultApplied,
            sessionId: 'session_1',
            modelId: 'default',
        });
        expect(sessionRpcWithServerScopeMock).toHaveBeenLastCalledWith({
            sessionId: 'session_1',
            serverId: undefined,
            method: 'session.model.transition',
            payload: {
                v: 1,
                selection: nativeDefaultSelection,
            },
        });

        storageState.current.sessions.session_1.metadata.modelSelectionIntentV1 = {
            v: 1,
            updatedAt: 10,
            selection: {
                agentTargetKey: 'backend:claude',
                providerConnectionId: 'pc_pending',
                modelId: 'pending-restart-model',
            },
        };
        storageState.current.sessions.session_1.metadata.providerBindingV1 = {
            v: 1,
            connectionId: 'pc_active',
            contributionKey: null,
            connectionRevision: 1,
            model: { id: 'active-model', name: 'Active model' },
            protocol: 'anthropic',
            materialization: 'spawnEnv',
            compatibilityFingerprint: 'compatibility:v1:active',
            bindingSecurityFingerprint: 'binding-security:v1:active',
            displaySnapshot: {
                providerName: 'Provider',
                connectionName: 'Active',
                connectionRole: 'named',
                connectionDisplayNameMode: 'custom',
            },
        };
        await expect(capturedDeps.current.sessionModelSet({
            sessionId: 'session_1',
            modelId: 'provider-next',
            serverId: 'server_1',
        })).resolves.toEqual({
            ...inheritedProviderApplied,
            sessionId: 'session_1',
            modelId: 'provider-next',
        });
        expect(sessionRpcWithServerScopeMock).toHaveBeenLastCalledWith({
            sessionId: 'session_1',
            serverId: 'server_1',
            method: 'session.model.transition',
            payload: {
                v: 1,
                selection: inheritedProviderSelection,
            },
        });
    });

    it('returns owner_unavailable when the active session transition owner transport rejects', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        storageState.current = {
            settings: {
                promptExternalLinksV1: { v: 1, links: [] },
            },
            applySettingsLocal: applySettingsLocalMock,
            sessions: {
                session_1: {
                    active: true,
                    metadata: {
                        agent: 'claude',
                    },
                },
            },
        };
        sessionRpcWithServerScopeMock.mockRejectedValueOnce(
            new Error('session host transport unavailable'),
        );

        createDefaultActionExecutor();

        await expect(capturedDeps.current.sessionModelSet({
            sessionId: 'session_1',
            modelId: 'provider-model',
            providerConnectionId: 'pc_work',
            serverId: 'server_1',
        })).resolves.toEqual({
            ok: false,
            errorCode: 'owner_unavailable',
            error: 'owner_unavailable',
            details: {
                status: 'owner_unavailable',
                activeSelection: null,
                requestedSelection: {
                    agentTargetKey: 'backend:claude',
                    providerConnectionId: 'pc_work',
                    modelId: 'provider-model',
                },
                reason: 'session host transport unavailable',
            },
        });
        expect(patchSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    });

    it('records inactive-session model intent through the existing structured metadata-CAS owner', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        storageState.current = {
            settings: {
                promptExternalLinksV1: { v: 1, links: [] },
            },
            applySettingsLocal: applySettingsLocalMock,
            sessions: {
                session_1: {
                    active: false,
                    metadata: {
                        agent: 'claude',
                    },
                },
            },
        };

        createDefaultActionExecutor();

        await expect(capturedDeps.current.sessionModelSet({
            sessionId: 'session_1',
            modelId: 'provider-model',
            providerConnectionId: 'pc_work',
            serverId: 'server_1',
        })).resolves.toMatchObject({
            ok: true,
            sessionId: 'session_1',
            modelId: 'provider-model',
            updatedAt: expect.any(Number),
        });
        expect(patchSessionMetadataWithRetryMock).toHaveBeenLastCalledWith(
            'session_1',
            expect.any(Function),
            {
                serverId: 'server_1',
                sessionExpectation: { kind: 'inactive_model_intent' },
            },
        );
        expect(storageState.current.sessions.session_1.metadata.modelSelectionIntentV1).toEqual({
            v: 1,
            updatedAt: expect.any(Number),
            selection: {
                agentTargetKey: 'backend:claude',
                providerConnectionId: 'pc_work',
                modelId: 'provider-model',
            },
        });

        await expect(capturedDeps.current.sessionModelSet({
            sessionId: 'session_1',
            modelId: 'default',
            providerConnectionId: null,
            serverId: 'server_1',
        })).resolves.toMatchObject({
            ok: true,
            sessionId: 'session_1',
            modelId: 'default',
            updatedAt: expect.any(Number),
        });
        expect(storageState.current.sessions.session_1.metadata.modelSelectionIntentV1).toEqual({
            v: 1,
            updatedAt: expect.any(Number),
            selection: {
                agentTargetKey: 'backend:claude',
                providerConnectionId: null,
                modelId: 'default',
            },
        });
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('reroutes an inactive snapshot through the live transition owner after the conditioned metadata CAS observes activation', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        storageState.current = {
            settings: {
                promptExternalLinksV1: { v: 1, links: [] },
            },
            applySettingsLocal: applySettingsLocalMock,
            sessions: {
                session_1: {
                    active: false,
                    metadata: {
                        agent: 'claude',
                        modelSelectionIntentV1: {
                            v: 1,
                            updatedAt: 10,
                            selection: {
                                agentTargetKey: 'backend:claude',
                                providerConnectionId: 'pc_pending',
                                modelId: 'pending-model',
                            },
                        },
                    },
                },
            },
        };
        patchSessionMetadataWithRetryMock.mockImplementationOnce(
            async () => {
                storageState.current.sessions.session_1 = {
                    ...storageState.current.sessions.session_1,
                    active: true,
                    metadata: {
                        ...storageState.current.sessions.session_1.metadata,
                        providerBindingV1: {
                            v: 1,
                            connectionId: 'pc_active',
                            contributionKey: null,
                            connectionRevision: 1,
                            model: { id: 'active-model', name: 'Active model' },
                            protocol: 'anthropic',
                            materialization: 'spawnEnv',
                            compatibilityFingerprint: 'compatibility:v1:active',
                            bindingSecurityFingerprint: 'binding-security:v1:active',
                            displaySnapshot: {
                                providerName: 'Provider',
                                connectionName: 'Active',
                                connectionRole: 'named',
                                connectionDisplayNameMode: 'custom',
                            },
                        },
                    },
                };
                throw Object.assign(new Error('Session became active'), {
                    code: 'session_active' as const,
                    retryable: false as const,
                });
            },
        );
        const liveResult = {
            ok: true as const,
            status: 'applied' as const,
            activeSelection: {
                agentTargetKey: 'backend:claude',
                providerConnectionId: 'pc_active',
                modelId: 'provider-next',
            },
        };
        sessionRpcWithServerScopeMock.mockResolvedValueOnce(liveResult);

        createDefaultActionExecutor();

        await expect(capturedDeps.current.sessionModelSet({
            sessionId: 'session_1',
            modelId: 'provider-next',
            serverId: 'server_1',
        })).resolves.toEqual({
            ...liveResult,
            sessionId: 'session_1',
            modelId: 'provider-next',
        });

        expect(patchSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
        expect(patchSessionMetadataWithRetryMock).toHaveBeenCalledWith(
            'session_1',
            expect.any(Function),
            {
                serverId: 'server_1',
                sessionExpectation: { kind: 'inactive_model_intent' },
            },
        );
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(sessionRpcWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'session_1',
            serverId: 'server_1',
            method: 'session.model.transition',
            payload: {
                v: 1,
                selection: liveResult.activeSelection,
            },
        });
    });

    it('does not retry metadata or invoke an unproven owner after an active conflict', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        storageState.current = {
            settings: {
                promptExternalLinksV1: { v: 1, links: [] },
            },
            applySettingsLocal: applySettingsLocalMock,
            sessions: {
                session_1: {
                    active: false,
                    metadata: {
                        agent: 'claude',
                    },
                },
            },
        };
        patchSessionMetadataWithRetryMock.mockRejectedValueOnce(
            Object.assign(new Error('Session became active'), {
                code: 'session_active' as const,
                retryable: false as const,
            }),
        );

        createDefaultActionExecutor();

        await expect(capturedDeps.current.sessionModelSet({
            sessionId: 'session_1',
            modelId: 'provider-next',
            serverId: 'server_1',
        })).resolves.toEqual({
            ok: false,
            errorCode: 'owner_unavailable',
            error: 'owner_unavailable',
            details: {
                status: 'owner_unavailable',
                activeSelection: null,
                requestedSelection: {
                    agentTargetKey: 'backend:claude',
                    providerConnectionId: null,
                    modelId: 'provider-next',
                },
                reason: 'session_model_transition_owner_unproven',
            },
        });

        expect(patchSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('reports an inactive model intent as superseded when a newer CAS winner is observed', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        storageState.current = {
            settings: {
                promptExternalLinksV1: { v: 1, links: [] },
            },
            applySettingsLocal: applySettingsLocalMock,
            sessions: {
                session_1: {
                    active: false,
                    metadata: {
                        agent: 'claude',
                    },
                },
            },
        };
        patchSessionMetadataWithRetryMock.mockImplementationOnce(
            async (_sessionId: string, updater: (metadata: any) => any) => {
                updater({});
                updater({
                    modelSelectionIntentV1: {
                        v: 1,
                        updatedAt: Number.MAX_SAFE_INTEGER,
                        selection: {
                            agentTargetKey: 'backend:claude',
                            providerConnectionId: null,
                            modelId: 'newer-model',
                        },
                    },
                });
            },
        );

        createDefaultActionExecutor();

        await expect(capturedDeps.current.sessionModelSet({
            sessionId: 'session_1',
            modelId: 'provider-model',
            providerConnectionId: 'pc_work',
            serverId: 'server_1',
        })).resolves.toEqual({
            ok: false,
            errorCode: 'superseded',
            error: 'superseded',
            details: {
                status: 'superseded',
                activeSelection: {
                    agentTargetKey: 'backend:claude',
                    providerConnectionId: null,
                    modelId: 'default',
                },
                requestedSelection: {
                    agentTargetKey: 'backend:claude',
                    providerConnectionId: 'pc_work',
                    modelId: 'provider-model',
                },
                reason: 'accepted_intent_was_superseded',
            },
        });
        expect(sessionRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('passes serverId through prompt registry install operations', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        createDefaultActionExecutor();

        await capturedDeps.current.promptRegistryInstall({
            machineId: 'machine-1',
            sourceId: 'skills_sh:featured',
            itemId: 'skills_sh:featured:item-1',
            configuredSources: [],
            serverId: 'server-1',
        });

        expect(installPromptRegistryItemMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            sourceId: 'skills_sh:featured',
            itemId: 'skills_sh:featured:item-1',
            serverId: 'server-1',
        }));
    });

    it('preserves serverId in approval headers when updating approval artifacts', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        createDefaultActionExecutor();

        await capturedDeps.current.approvalsUpdate({
            artifactId: 'approval-1',
            request: {
                v: 1,
                status: 'approved',
                createdAtMs: 1,
                updatedAtMs: 2,
                createdBy: { surface: 'system', sessionId: 'session-1' },
                actionId: 'prompt_asset.export',
                actionArgs: {},
                summary: 'Export prompt',
                serverId: 'server-1',
                decision: { kind: 'approve', decidedAtMs: 2 },
            },
        });

        expect(updateArtifactWithHeaderMock).toHaveBeenCalledWith(
            'approval-1',
            expect.objectContaining({
                kind: 'approval_request.v1',
                approvalStatus: 'approved',
                serverId: 'server-1',
            }),
            expect.any(String),
        );
    });

    it('routes simulator runtime actions through the canonical host bridge and keeps other families fail-closed', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        storageState.current = {
            settings: {
                promptExternalLinksV1: { v: 1, links: [] },
            },
            applySettingsLocal: applySettingsLocalMock,
            sessions: {
                session_1: {
                    active: true,
                    metadata: {
                        machineId: 'machine_1',
                        path: '/repo',
                    },
                },
            },
            machines: {
                machine_1: {
                    id: 'machine_1',
                    active: true,
                    metadata: {},
                },
            },
        };
        const snapshot = {
            v: 1 as const,
            machineId: 'machine_1',
            generatedAt: 2_000,
            refreshState: 'idle' as const,
            resources: [],
            diagnostics: [],
        };
        const localServicePreviewSnapshot = {
            v: 1 as const,
            machineId: 'machine_1',
            generatedAt: 2_500,
            refreshState: 'idle' as const,
            resources: [],
            diagnostics: [],
        };
        const localServiceInventorySnapshot = {
            v: 1 as const,
            machineId: 'machine_1',
            generatedAt: 3_000,
            refreshState: 'idle' as const,
            entries: [],
            diagnostics: [],
        };
        const localServiceLauncherSnapshot = {
            v: 1 as const,
            machineId: 'machine_1',
            sessionId: 'session_1',
            updatedAt: 4_000,
            targets: [],
        };
        const localServiceLauncherStartResponse = {
            protocolVersion: 1 as const,
            machineId: 'machine_1',
            targetId: 'target_1',
            status: 'succeeded' as const,
            snapshot: localServiceLauncherSnapshot,
        };
        const publicExposure = {
            exposureId: 'public_preview_1',
            previewId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
            mode: 'secret_link' as const,
            state: 'active' as const,
            publicUrl: 'https://preview.example.test/s/public_preview_1',
            issuedAt: 1_000,
            expiresAt: 601_000,
            auditEventIds: ['audit_1'],
            rateLimitProfileId: 'default',
        };
        const publicPreviewSnapshot = {
            v: 1 as const,
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            generatedAt: 6_000,
            refreshState: 'idle' as const,
            policy: {
                enabled: true,
                allowedModes: ['secret_link' as const],
                maxTtlMs: 600_000,
                maxConcurrentExposures: 1,
                dnsTlsRequired: true,
                auditRequired: true,
                rateLimitProfileIds: ['default'],
            },
            exposures: [publicExposure],
            diagnostics: [],
        };
        const publicPreviewCreateResponse = {
            protocolVersion: 1 as const,
            exposure: publicExposure,
            snapshot: publicPreviewSnapshot,
        };
        const publicPreviewCopyUrlResponse = {
            protocolVersion: 1 as const,
            machineId: 'machine_1',
            sessionId: 'session_1',
            previewId: 'preview_1',
            exposureId: 'public_preview_1',
            publicUrl: publicExposure.publicUrl,
        };
        const localServiceActionResult = {
            v: 1 as const,
            requestId: 'request_1',
            action: 'copy_url' as const,
            status: 'succeeded' as const,
            auditEvents: [{
                v: 1 as const,
                eventId: 'request_1:0:succeeded',
                requestId: 'request_1',
                machineId: 'machine_1',
                action: 'copy_url' as const,
                result: 'succeeded' as const,
                recordedAt: 5_000,
            }],
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            snapshot,
        }).mockResolvedValueOnce({
            protocolVersion: 1,
            snapshot: localServicePreviewSnapshot,
        }).mockResolvedValueOnce({
            protocolVersion: 1,
            snapshot: localServiceInventorySnapshot,
        }).mockResolvedValueOnce({
            protocolVersion: 1,
            snapshot: localServiceLauncherSnapshot,
        }).mockResolvedValueOnce(localServiceLauncherStartResponse).mockResolvedValueOnce({
            protocolVersion: 1,
            result: localServiceActionResult,
        }).mockResolvedValueOnce({
            protocolVersion: 1,
            snapshot: publicPreviewSnapshot,
        }).mockResolvedValueOnce(publicPreviewCreateResponse).mockResolvedValueOnce(publicPreviewCopyUrlResponse);

        createDefaultActionExecutor();

        expect(typeof capturedDeps.current.runtimeActionExecute).toBe('function');

        await expect(capturedDeps.current.runtimeActionExecute({
            actionId: 'devices.simulator.list',
            input: { type: 'simulator.devices.list' },
            context: {
                defaultSessionId: 'session_1',
                serverId: 'server_1',
            },
        })).resolves.toEqual(snapshot);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            serverId: 'server_1',
        }));

        await expect(capturedDeps.current.runtimeActionExecute({
            actionId: 'localServices.preview.status',
            input: {},
            context: {
                defaultSessionId: 'session_1',
                serverId: 'server_1',
            },
        })).resolves.toEqual({
            generatedAt: 2_500,
            refreshState: 'idle',
            previews: [],
            diagnostics: [],
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            serverId: 'server_1',
        }));

        await expect(capturedDeps.current.runtimeActionExecute({
            actionId: 'localServices.inventory.list',
            input: {},
            context: {
                defaultSessionId: 'session_1',
                serverId: 'server_1',
            },
        })).resolves.toEqual(localServiceInventorySnapshot);
        await expect(capturedDeps.current.runtimeActionExecute({
            actionId: 'localServices.launcher.snapshot',
            input: { sessionId: 'session_1' },
            context: {
                defaultSessionId: 'session_1',
                serverId: 'server_1',
            },
        })).resolves.toEqual(localServiceLauncherSnapshot);
        await expect(capturedDeps.current.runtimeActionExecute({
            actionId: 'localServices.launcher.start',
            input: {
                machineId: 'machine_1',
                targetId: 'target_1',
                sessionId: 'session_1',
            },
            context: {
                defaultSessionId: 'session_1',
                serverId: 'server_1',
            },
        })).resolves.toEqual(localServiceLauncherStartResponse);
        await expect(capturedDeps.current.runtimeActionExecute({
            actionId: 'localServices.actions.copyUrl',
            input: {
                requestId: 'request_1',
                target: { kind: 'inventory_entry', inventoryEntryId: 'entry_1', machineId: 'machine_1' },
                action: 'copy_url',
                force: false,
            },
            context: {
                defaultSessionId: 'session_1',
                serverId: 'server_1',
            },
        })).resolves.toEqual(localServiceActionResult);
        await expect(capturedDeps.current.runtimeActionExecute({
            actionId: 'localServices.publicPreview.status',
            input: {
                sessionId: 'session_1',
                previewId: 'preview_1',
            },
            context: {
                defaultSessionId: 'session_1',
                serverId: 'server_1',
            },
        })).resolves.toEqual(publicPreviewSnapshot);
        await expect(capturedDeps.current.runtimeActionExecute({
            actionId: 'localServices.publicPreview.create',
            input: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                mode: 'secret_link',
                ttlMs: 600_000,
            },
            context: {
                defaultSessionId: 'session_1',
                serverId: 'server_1',
            },
        })).resolves.toEqual(publicPreviewCreateResponse);
        await expect(capturedDeps.current.runtimeActionExecute({
            actionId: 'localServices.publicPreview.copyUrl',
            input: {
                machineId: 'machine_1',
                sessionId: 'session_1',
                previewId: 'preview_1',
                exposureId: 'public_preview_1',
            },
            context: {
                defaultSessionId: 'session_1',
                serverId: 'server_1',
            },
        })).resolves.toEqual(publicPreviewCopyUrlResponse);
        expect(machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method: string }).method)).toContain(
            'daemon.localServices.inventory.snapshot',
        );
        expect(machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method: string }).method)).toContain(
            'daemon.localServices.launcher.snapshot',
        );
        expect(machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method: string }).method)).toContain(
            'daemon.localServices.launcher.start',
        );
        expect(machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method: string }).method)).toContain(
            'daemon.localServices.actions.execute',
        );
        expect(machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method: string }).method)).toContain(
            'daemon.localServices.publicPreview.status',
        );
        expect(machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method: string }).method)).toContain(
            'daemon.localServices.publicPreview.create',
        );
        expect(machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method: string }).method)).toContain(
            'daemon.localServices.publicPreview.copyUrl',
        );

        await expect(capturedDeps.current.runtimeActionExecute({
            actionId: 'localServices.launcher.snapshot',
            input: {},
            context: {},
        })).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:local_services_machine_unavailable',
        });
        await expect(capturedDeps.current.runtimeActionExecute({
            actionId: 'browser.navigate',
            input: {
                kind: 'navigate',
                commandId: 'command_missing_browser_host',
                browserSessionId: 'browser_session_1',
                viewId: 'browser_view_1',
                url: 'https://browser.example.test/',
            },
            context: {},
        })).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:browser:browser_control_unavailable',
        });
        await expect(capturedDeps.current.runtimeActionExecute({
            actionId: 'peerMediation.observability.snapshot',
            input: {},
            context: {},
        })).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:peerMediation:runtime_family_unimplemented',
        });
    });

    it('routes browser.navigate through a registered browser surface adapter', async () => {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const {
            applyBrowserControlEvent,
            createBrowserControlState,
        } = await import('@/sync/domains/browser/control');
        const { buildBrowserAdapterCapabilities } = await import('@/sync/domains/browser/adapters/capabilities');
        const { registerBrowserRuntimeControlAdapter } = await import('@/sync/domains/browser/actions/runtimeControlRegistry');

        const browserSessionId = 'browser_session_registered';
        const viewId = 'view_registered';
        const capabilities = buildBrowserAdapterCapabilities({
            adapterKind: 'localPreview',
            supportedTargetKinds: ['localServicePreview'],
            supportedRenderEngines: ['webIframe'],
        });
        let state = [
            {
                kind: 'sessionCreated' as const,
                eventId: 'event_session',
                browserSessionId,
                profileId: 'profile_1',
                occurredAt: 1_000,
            },
            {
                kind: 'viewOpened' as const,
                eventId: 'event_view',
                browserSessionId,
                viewId,
                target: {
                    kind: 'localServicePreview' as const,
                    targetId: 'preview_1',
                    sessionId: 'session_1',
                    machineId: 'machine_1',
                    display: {
                        title: 'Preview',
                        addressLabel: 'localhost:5173',
                    },
                },
                platform: 'web' as const,
                currentUrl: 'https://preview.happier.test/',
                adapterKind: 'localPreview' as const,
                engineKind: 'webIframe' as const,
                adapterCapabilities: {
                    ...capabilities,
                    navigation: {
                        canNavigate: true,
                        canGoBack: false,
                        canGoForward: false,
                        canReload: true,
                        canStop: true,
                    },
                },
                occurredAt: 1_001,
            },
            {
                kind: 'viewFocused' as const,
                eventId: 'event_focus',
                browserSessionId,
                viewId,
                occurredAt: 1_002,
            },
        ].reduce(
            (nextState, event) => applyBrowserControlEvent(nextState, event),
            createBrowserControlState(),
        );
        const cleanup = registerBrowserRuntimeControlAdapter({
            browserSessionId,
            control: {
                readState: () => state,
                applyDispatchResult: (result) => {
                    state = result.state;
                },
            },
        });

        try {
            createDefaultActionExecutor();

            await expect(capturedDeps.current.runtimeActionExecute({
                actionId: 'browser.navigate',
                input: {
                    kind: 'navigate',
                    commandId: 'command_registered_browser_host',
                    browserSessionId,
                    viewId,
                    url: 'https://preview.happier.test/registered',
                },
                context: {},
            })).resolves.toMatchObject({
                v: 1,
                actionId: 'browser.navigate',
                status: 'accepted',
            });
            expect(state.viewsById[viewId]?.pendingUrl).toBe('https://preview.happier.test/registered');
        } finally {
            cleanup();
        }
    });
});
