import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { AIBackendProfileSchema, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { installProfileEditFormModuleMocks } from './profileEditFormTestHelpers';
import { ProfileEditForm, type ProfileEditFormProps } from './ProfileEditForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installProfileEditFormModuleMocks();

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['codex'],
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex'],
    DEFAULT_AGENT_ID: 'codex',
    getAgentCore: () => ({
        sessionStorage: { direct: true, persisted: true },
        permissions: { modeGroup: 'codexLike' },
        cli: { machineLoginKey: 'codex' },
        ui: { agentPickerIconName: 'terminal-outline' },
        displayNameKey: 'agent.codex',
    }),
    getAgentBehavior: () => ({
        newSession: {
            supportsTranscriptStorageMode: () => true,
        },
    }),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

function buildProfile(overrides: Record<string, unknown> = {}): AIBackendProfile {
    return AIBackendProfileSchema.parse({
        id: 'profile-1',
        name: 'Profile',
        environmentVariables: [],
        defaultPermissionModeByAgent: {},
        defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByAgent: {},
        defaultPersistenceModeByTargetKey: {},
        compatibility: {},
        compatibilityByTargetKey: { 'agent:codex': true },
        envVarRequirements: [],
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
        ...overrides,
    });
}

describe('ProfileEditForm coding prompt behavior', () => {
    it('persists sparse profile overrides and removes them when both controls inherit the Account setting', async () => {
        const saveRef = { current: null as null | (() => boolean) };
        const onSave = vi.fn<ProfileEditFormProps['onSave']>(() => true);
        const screen = await renderScreen(React.createElement(ProfileEditForm, {
            profile: buildProfile({
                codingPromptBehaviorV1: {
                    v: 1,
                    sessionTitleUpdates: 'initial',
                    responseOptions: 'disabled',
                },
            }),
            machineId: null,
            onSave,
            onCancel: vi.fn(),
            saveRef,
        }));

        const dropdowns = screen.findAllByType('DropdownMenu' as never);
        const titleDropdown = dropdowns.find((node) =>
            node.props.itemTrigger?.itemProps?.testID === 'profile-session-title-updates-mode-trigger');
        const responseDropdown = dropdowns.find((node) =>
            node.props.itemTrigger?.itemProps?.testID === 'profile-response-options-mode-trigger');

        expect(titleDropdown?.props.selectedId).toBe('initial');
        expect(responseDropdown?.props.selectedId).toBe('disabled');
        expect(titleDropdown?.props.items.map((item: { id: string }) => item.id)).toEqual([
            '__account__',
            'disabled',
            'initial',
            'ongoing',
        ]);
        expect(responseDropdown?.props.items.map((item: { id: string }) => item.id)).toEqual([
            '__account__',
            'agent',
            'disabled',
        ]);

        await act(async () => {
            titleDropdown?.props.onSelect('__account__');
            responseDropdown?.props.onSelect('__account__');
        });
        expect(saveRef.current?.()).toBe(true);
        expect(onSave.mock.calls.at(-1)?.[0].codingPromptBehaviorV1).toBeUndefined();

        const updatedDropdowns = screen.findAllByType('DropdownMenu' as never);
        const updatedTitleDropdown = updatedDropdowns.find((node) =>
            node.props.itemTrigger?.itemProps?.testID === 'profile-session-title-updates-mode-trigger');
        const updatedResponseDropdown = updatedDropdowns.find((node) =>
            node.props.itemTrigger?.itemProps?.testID === 'profile-response-options-mode-trigger');
        await act(async () => {
            updatedTitleDropdown?.props.onSelect('ongoing');
            updatedResponseDropdown?.props.onSelect('agent');
        });
        expect(saveRef.current?.()).toBe(true);
        expect(onSave.mock.calls.at(-1)?.[0].codingPromptBehaviorV1).toEqual({
            v: 1,
            sessionTitleUpdates: 'ongoing',
            responseOptions: 'agent',
        });
    });
});
