import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { buildExistingSessionAutomationAuthoringContext } from '@/components/sessions/authoring/context/buildExistingSessionAutomationAuthoringContext';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import { renderScreen } from '@/dev/testkit';
import { createCapturingComponent } from '@/dev/testkit/mocks/components';
import { installAutomationComponentCommonModuleMocks } from '../automationComponentTestHelpers';

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type CapturedItemProps = Readonly<{
    title?: unknown;
    subtitle?: unknown;
}>;

const capturedItems: CapturedItemProps[] = [];

installAutomationComponentCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => {
                const labels: Record<string, string> = {
                    'common.details': 'Details',
                    'common.machine': 'Machine',
                    'common.path': 'Path',
                    'profiles.title': 'Profiles',
                    'settingsSession.replayResume.summaryRunner.backendTitle': 'Backend',
                    'terminal.encryption': 'Encryption',
                    'terminal.endToEndEncrypted': 'End-to-end encrypted',
                    'welcome.chooseEncryptionPlain': 'Continue without encryption',
                    'settingsSession.transcript.title': 'Transcript',
                    'sessionsList.storageDirectTab': 'Direct',
                    'sessionsList.storagePersistedTab': 'Happier',
                    'settingsActions.targets.mcp.title': 'MCP',
                    'connectedServices.title': 'Connected services',
                    'settingsProviders.resumeSupportTitle': 'Resume support',
                    'settingsProviders.resumeSupportSupported': 'Supported',
                    'settingsProviders.resumeSupportSupportedExperimental': 'Supported (experimental)',
                };
                return labels[key] ?? key;
            },
        });
    },
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: createCapturingComponent('Item', (props: Record<string, unknown> & { title?: unknown; subtitle?: unknown }) => {
        capturedItems.push({
            title: props.title,
            subtitle: props.subtitle,
        });
    }),
}));

const BASE_DRAFT: SessionAuthoringDraft = {
    targetType: 'existing_session',
    directory: '/repo/project',
    checkoutCreationDraft: null,
    prompt: 'Summarize the latest changes',
    displayText: 'Summarize the latest changes',
    agentId: 'codex',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    transcriptStorage: 'direct',
    profileId: 'profile-1',
    environmentVariables: null,
    resumeSessionId: null,
    permissionMode: 'acceptEdits',
    permissionModeUpdatedAt: 123,
    modelId: 'gpt-5',
    modelUpdatedAt: 456,
    mcpSelection: {
        forceIncludeServerIds: ['managed-1', 'managed-2'],
        forceExcludeServerIds: [],
    } as any,
    connectedServices: {
        v: 1,
        bindingsByServiceId: {
            github: { source: 'connected', profileId: 'github-1' },
            slack: { source: 'native' },
        },
    },
    terminal: null,
    windowsRemoteSessionLaunchMode: null,
    windowsRemoteSessionConsole: null,
    experimentalCodexAcp: null,
    acpSessionModeId: null,
    existingSessionId: 'session-1',
    sessionEncryptionMode: 'e2ee',
    sessionEncryptionKeyBase64: 'secret',
    sessionEncryptionVariant: 'dataKey',
};

describe('ExistingSessionAutomationContextSection', () => {
    it('renders the inherited machine, path, profile, and resume rows for a resumable session', async () => {
        capturedItems.length = 0;
        const { ExistingSessionAutomationContextSection } = await import('./ExistingSessionAutomationContextSection');

        await renderScreen(
            <ExistingSessionAutomationContextSection
                context={buildExistingSessionAutomationAuthoringContext({
                    draft: BASE_DRAFT,
                    session: {
                        id: 'session-1',
                        encryptionMode: 'e2ee',
                        permissionMode: 'acceptEdits',
                        permissionModeUpdatedAt: 123,
                        modelMode: 'gpt-5',
                        modelModeUpdatedAt: 456,
                        metadata: {
                            path: '/repo/project',
                            displayName: 'Leeroy Mac',
                            host: 'leeroy.local',
                            machineId: 'machine-1',
                        },
                    },
                    sessionDekBase64: 'secret',
                    availability: {
                        kind: 'ready',
                        machineId: 'machine-1',
                        eligibility: {
                            eligible: true,
                            agentId: 'codex',
                            strategy: 'vendor_resume',
                        },
                    },
                })}
            />,
        );

        expect(capturedItems).toEqual([
            { title: 'Backend', subtitle: 'codex' },
            { title: 'Encryption', subtitle: 'End-to-end encrypted' },
            { title: 'Transcript', subtitle: 'Direct' },
            { title: 'Machine', subtitle: 'Leeroy Mac' },
            { title: 'Path', subtitle: '/repo/project' },
            { title: 'Profiles', subtitle: 'profile-1' },
            { title: 'MCP (2)', subtitle: undefined },
            { title: 'Connected services (1)', subtitle: undefined },
            { title: 'Resume support', subtitle: 'Supported' },
        ]);
    });

    it('hides the optional profile row when the automation draft does not carry one', async () => {
        capturedItems.length = 0;
        const { ExistingSessionAutomationContextSection } = await import('./ExistingSessionAutomationContextSection');

        await renderScreen(
            <ExistingSessionAutomationContextSection
                context={buildExistingSessionAutomationAuthoringContext({
                    draft: {
                        ...BASE_DRAFT,
                        backendTarget: null,
                        sessionEncryptionMode: 'plain',
                        transcriptStorage: null,
                        profileId: null,
                        mcpSelection: null,
                        connectedServices: null,
                    },
                    session: {
                        id: 'session-1',
                        encryptionMode: 'plain',
                        permissionMode: 'acceptEdits',
                        permissionModeUpdatedAt: 123,
                        modelMode: 'gpt-5',
                        modelModeUpdatedAt: 456,
                        metadata: {
                            path: '/repo/project',
                            host: 'leeroy.local',
                            machineId: 'machine-1',
                        },
                    },
                    sessionDekBase64: null,
                    availability: {
                        kind: 'ready',
                        machineId: 'machine-1',
                        eligibility: {
                            eligible: true,
                            agentId: 'codex',
                            strategy: 'happy_attach',
                        },
                    },
                })}
            />,
        );

        expect(capturedItems.map((item) => item.title)).toEqual([
            'Backend',
            'Encryption',
            'Machine',
            'Path',
            'Resume support',
        ]);
    });
});
