import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';

import { installProfileEditFormModuleMocks } from './profileEditFormTestHelpers';
import { renderScreen } from '@/dev/testkit';

installProfileEditFormModuleMocks({
    storageModule: () => ({
        useSetting: (key: string) => {
            if (key === 'newSessionDefaultPersistenceModeV1') return 'persisted';
            if (key === 'newSessionDefaultPersistenceModeByTargetKeyV1') return {};
            return {};
        },
        useAllMachines: () => [],
        useMachine: () => null,
        useSettings: () => ({ opencodeBackendMode: 'server' }),
        useSettingMutable: (key: string) => {
            if (key === 'favoriteMachines') return [[], vi.fn()] as const;
            if (key === 'secrets') return [[], vi.fn()] as const;
            if (key === 'secretBindingsByProfileId') return [{}, vi.fn()] as const;
            return [[], vi.fn()] as const;
        },
    }),
});

// The shared form helpers stub DropdownMenu as `() => null`, which never invokes the trigger
// render prop — exactly how the coding-prompt triggers' icons escaped test coverage. This file
// mounts the real trigger content instead. vi.doMock (not hoisted) so it registers AFTER the
// shared helpers' own DropdownMenu stub and wins.
vi.doMock('@/components/ui/forms/dropdown/DropdownMenu', () => {
    return {
        DropdownMenu: (props: {
            trigger: (state: { open: boolean; toggle: () => void }) => React.ReactElement;
        }) => React.createElement(
            'dropdown-menu-stub',
            null,
            props.trigger({ open: false, toggle: () => undefined }),
        ),
    };
});
// The helper's ItemGroup stub omits the selection context the real Item consumes; the stub in
// profileEditFormTestHelpers now exposes ItemGroupSelectionContext for exactly this case.

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'sessions.direct',
}));

vi.mock('@/hooks/auth/useCLIDetection', () => ({
    useCLIDetection: () => ({ status: 'unknown' }),
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
        resolveInitialPermissionMode: () => 'default',
        resolveDefaultPersistenceMode: () => 'persisted',
        formatProfileBackendEntryKey: () => 'codex',
    }),
    isProfileCompatibleWithBackendTarget: () => true,
}));

vi.mock('@/sync/domains/profiles/profileCompatibility', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    isProfileCompatibleWithBackendTarget: () => true,
}));

const { ProfileEditForm } = await import('./ProfileEditForm');

function buildProfile() {
    return {
        id: 'p1',
        name: 'P',
        target: 'codex',
        env: {},
        envVarRequirements: [],
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
    } as never;
}

describe('ProfileEditForm coding prompt behavior icons render', () => {
    it('renders the coding-prompt dropdown triggers through the canonical Icon component without a bare Ionicons reference', async () => {
        // Regression guard: the section shipped referencing an unimported `Ionicons`, which
        // crashed the profile form at render time on every platform while tests stayed green
        // (their DropdownMenu stub never invoked the trigger). Rendering must not throw, and
        // both trigger rows must mount.
        const screen = await renderScreen(React.createElement(ProfileEditForm, {
            profile: buildProfile(),
            machineId: null,
            onSave: vi.fn(() => true),
            onCancel: vi.fn(),
            saveRef: { current: null },
        }));

        expect(screen).toBeDefined();
        const rendered = JSON.stringify(screen.tree.toJSON());
        expect(rendered).toContain('profiles.codingPromptBehavior.sessionTitleUpdates.label');
        expect(rendered).toContain('profiles.codingPromptBehavior.responseOptions.label');
    });
});
