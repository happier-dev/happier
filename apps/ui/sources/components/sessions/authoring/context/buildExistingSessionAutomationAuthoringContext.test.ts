import { describe, expect, it } from 'vitest';

import type { ExistingSessionAutomationAvailability } from '@/sync/domains/automations/existingSessionAutomationAvailability';

import type { SessionAuthoringDraft } from '../draft/sessionAuthoringDraft';
import { buildExistingSessionAutomationAuthoringContext } from './buildExistingSessionAutomationAuthoringContext';

const BASE_DRAFT: SessionAuthoringDraft = {
    targetType: 'existing_session',
    executionTarget: null,
    directory: '/repo/project',
    checkoutCreationDraft: null,
    organizationPlacement: { folderId: null, tagIds: [] },
    prompt: 'Summarize the latest changes',
    displayText: 'Summarize the latest changes',
    agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
    },
    transcriptStorage: 'direct',
    profileId: 'profile-1',
    environmentVariables: null,
    resumeSessionId: null,
    permissionMode: 'acceptEdits',
    permissionModeUpdatedAt: 123,
    modelSelection: {
        v: 1,
        updatedAt: 456,
        ref: {
            agentTargetKey: 'agent:happier.agent.claude/claude',
            providerConnectionId: null,
            modelId: 'gpt-5',
        },
    },
    mcpSelection: {
        v: 1,
        managedServersEnabled: true,
        forceIncludeServerIds: ['managed-1'],
        forceExcludeServerIds: [],
    },
    connectedServices: {
        v: 1,
        bindingsByServiceId: {
            github: { source: 'connected' },
        },
    },
    terminal: { mode: 'integrated' },
    windowsRemoteSessionLaunchMode: null,
    windowsRemoteSessionConsole: null,
    runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: { backendMode: 'appServer' },
    },
    acpSessionModeId: null,
    sessionConfigOptionOverrides: null,
    existingSessionId: 'session-1',
    sessionEncryptionMode: 'e2ee',
    sessionEncryptionKeyBase64: 'dek-1',
    sessionEncryptionVariant: 'dataKey',
    automation: {
        enabled: true,
        name: 'Nightly summary',
        description: 'Summarize the latest state',
        triggers: [
            {
                clientId: 'nightly-summary-schedule',
                definition: {
                    kind: 'schedule',
                    enabled: true,
                    schedule: {
                        kind: 'interval',
                        scheduleExpr: null,
                        everyMs: 60 * 60_000,
                        timezone: null,
                    },
                },
            },
            {
                clientId: 'nightly-summary-turn-completed',
                definition: {
                    kind: 'sessionLifecycle',
                    enabled: false,
                    event: 'parentTurnCompleted',
                    scope: {
                        kind: 'exactTurn',
                        sourceSessionId: 'session-1',
                        sourceTurnId: 'turn-1',
                    },
                    consumption: 'once',
                },
            },
        ],
    },
};

const READY_AVAILABILITY: ExistingSessionAutomationAvailability = {
    kind: 'ready',
    machineId: 'machine-1',
    eligibility: {
        eligible: true,
        strategy: 'happy_attach',
        compatBackendId: 'review-bot',
    },
};

describe('buildExistingSessionAutomationAuthoringContext', () => {
    it('builds a shared authoring context from the live session snapshot and existing capability contract', () => {
        const context = buildExistingSessionAutomationAuthoringContext({
            session: {
                id: 'session-1',
                encryptionMode: 'e2ee',
                metadata: {
                    path: '/repo/project',
                    host: 'qa-host',
                    profileId: 'profile-1',
                    flavor: 'claude',
                    machineId: 'machine-1',
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            github: { source: 'connected' },
                        },
                    },
                },
                permissionMode: 'acceptEdits',
                permissionModeUpdatedAt: 123,
                modelMode: 'gpt-5',
                modelModeUpdatedAt: 456,
            },
            draft: BASE_DRAFT,
            availability: READY_AVAILABILITY,
            sessionDekBase64: 'dek-1',
        });

        expect(context.kind).toBe('automationExistingSession');
        expect(context.snapshot.directory).toBe('/repo/project');
        expect(context.snapshot.existingSessionId).toBe('session-1');
        expect(context.capabilities.message).toBe('editable');
        expect(context.capabilities.backend).toBe('inherited');
        expect(context.capabilities.mcp).toBe('inherited');
        expect(context.capabilities.connectedServices).toBe('inherited');
    });
});
