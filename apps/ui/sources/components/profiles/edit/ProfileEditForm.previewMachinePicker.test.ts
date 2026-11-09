import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { buildBackendTargetKeyV2, parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { ProfileEditForm } from './ProfileEditForm';
import { Platform } from 'react-native';
import {
    installProfileEditFormModuleMocks,
    loadProfileEditFormCatalogFixtureOwners,
    publishProfileEditFormAcpCatalogFixture,
} from './profileEditFormTestHelpers';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const capture = vi.hoisted(() => ({
    previewMachinePress: null as null | (() => void),
    reset() {
        this.previewMachinePress = null;
    },
}));
const boundarySpies = vi.hoisted(() => ({ push: vi.fn(), show: vi.fn(), alert: vi.fn() }));

// The real editor is a static dependency, so install these boundaries before
// its imports evaluate; the helper's runtime registration would be too late.
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: { backendTargetKey: 'acpBackend:review-bot' },
    router: { push: boundarySpies.push },
}).module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: {
    show: boundarySpies.show,
    alert: boundarySpies.alert,
} }).module);

installProfileEditFormModuleMocks({
    reactNative: () =>
        createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (spec: { ios?: unknown; default?: unknown }) =>
                    spec && 'ios' in spec ? spec.ios : spec?.default,
            },
            View: 'View',
            Text: 'Text',
            TextInput: 'TextInput',
            Pressable: 'Pressable',
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
            useWindowDimensions: () => ({ height: 800, width: 400 }),
        }),
    storageModule: () =>
        createStorageModuleStub({
            useSetting: () => ({}),
            useSettings: () => ({}),
            useActiveMachineFacts: () => [{ id: 'm1', metadata: { displayName: 'M1' } }],
            useMachine: () => null,
            useCurrentSecretBindingsByProfileIdMutable: () => [{}, vi.fn()] as const,
            useSettingMutable: (key: string) => {
                if (key === 'favoriteMachines') return [[], vi.fn()] as const;
                if (key === 'secrets') return [[], vi.fn()] as const;
                return [[], vi.fn()] as const;
            },
        }),
    routeParams: {
        backendTargetKey: 'acpBackend:review-bot',
    },
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));


vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => [],
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    DEFAULT_AGENT_ID: 'claude',
    isBundledAgentId: (value: unknown): value is 'claude' | 'customAcp' =>
        typeof value === 'string' && ['claude', 'customAcp'].includes(value),
    getAgentCore: () => ({ permissions: { modeGroup: 'default' } }),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ title, onPress }: { title?: string; onPress?: () => void }) => {
        if (title === 'profiles.previewMachine.itemTitle' && typeof onPress === 'function') {
            capture.previewMachinePress = onPress;
        }
        return null;
    },
}));

await loadProfileEditFormCatalogFixtureOwners();
let disposeCatalog: (() => void) | undefined;
beforeEach(async () => {
    Platform.OS = 'ios';
    disposeCatalog = await publishProfileEditFormAcpCatalogFixture(AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [] }));
});
afterEach(() => { standardCleanup(); disposeCatalog?.(); disposeCatalog = undefined; });

function buildProfile(): AIBackendProfile {
    return {
        id: 'p1',
        name: 'P',
        environmentVariables: [],
        defaultPermissionModeByAgent: {},
        defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByAgent: {},
        defaultPersistenceModeByTargetKey: {},
        compatibility: { claude: true, codex: true, gemini: true },
        compatibilityByTargetKey: {
            'agent:claude': true,
            'agent:codex': true,
            'agent:gemini': true,
        },
        envVarRequirements: [],
        isBuiltIn: false,
        defaultEnabled: true,
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
    };
}

describe('ProfileEditForm (native preview machine picker)', () => {
    it('opens a picker screen instead of a modal overlay on native', async () => {
        capture.reset();
        boundarySpies.push.mockClear();
        boundarySpies.show.mockClear();
        boundarySpies.alert.mockClear();


        await renderScreen(React.createElement(ProfileEditForm, {
            profile: buildProfile(),
            machineId: null,
            onSave: () => true,
            onCancel: vi.fn(),
        }));

        expect(capture.previewMachinePress).toBeTruthy();

        await act(async () => {
            capture.previewMachinePress?.();
        });

        expect(boundarySpies.show).not.toHaveBeenCalled();
        expect(boundarySpies.push).toHaveBeenCalledTimes(1);
        expect(boundarySpies.push).toHaveBeenCalledWith(expect.objectContaining({
            pathname: '/new/pick/preview-machine',
            params: expect.objectContaining({
                backendTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' }),
                backendTarget: JSON.stringify(parseBackendTargetKeyV2(buildBackendTargetKeyV2({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' }))),
            }),
        }));
    });
});
