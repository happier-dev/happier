import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type renderer from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

/**
 * Parity pin for the shared Session-authoring effective-policy owner.
 *
 * The composer's Agent/model chip and its permission chip must keep naming what
 * the canonical policy owners resolve — not the raw props. This is asserted
 * against the real `describeEffectiveModelMode` /
 * `getPermissionModeBadgeLabelForAgentType` owners (only host boundaries are
 * mocked), so moving the composition out of `AgentInput` into
 * `useSessionAuthoringControls` cannot quietly change what the composer shows.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installAgentInputCommonModuleMocks({
    storageStore: async () => {
        const { createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
        const store = createStorageStoreMock({ artifacts: {}, settingsScope: null });
        return { storage: store, getStorage: () => store };
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
            Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Text', props, props.children),
            Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Pressable', props, props.children),
            ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('ScrollView', props, props.children),
            ActivityIndicator: (props: Record<string, unknown>) =>
                React.createElement('ActivityIndicator', props, null),
            Platform: { OS: 'ios', select: (value: any) => value.ios },
            AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
            useWindowDimensions: () => ({ width: 900, height: 700 }),
            Dimensions: { get: () => ({ width: 900, height: 700, scale: 1, fontScale: 1 }) },
        });
    },
    icons: async () => ({
        Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
        Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props, null),
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'profiles') return [];
                if (key === 'agentInputEnterToSend') return true;
                if (key === 'agentInputActionBarLayout') return 'wrap';
                if (key === 'agentInputChipDensity') return 'labels';
                if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
                return null;
            },
            useSettings: () => ({
                profiles: [],
                agentInputEnterToSend: true,
                agentInputActionBarLayout: 'wrap',
                agentInputChipDensity: 'labels',
                sessionPermissionModeApplyTiming: 'immediate',
            }),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionMessagesById: () => ({}),
            useSessionMessagesVersion: () => 0,
            useSessionMessagesReducerState: () => null,
        });
    },
});

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/store/hooks')>();
    return { ...actual, useLocalSetting: () => 1, useSessionServerId: () => null };
});

type JsonNode =
    | renderer.ReactTestRendererJSON
    | renderer.ReactTestRendererJSON[]
    | string
    | number
    | null;

function flattenJson(node: JsonNode, out: renderer.ReactTestRendererJSON[] = []): renderer.ReactTestRendererJSON[] {
    if (!node) return out;
    if (typeof node === 'string' || typeof node === 'number') return out;
    if (Array.isArray(node)) {
        for (const entry of node) flattenJson(entry, out);
        return out;
    }
    out.push(node);
    if (node.children) flattenJson(node.children as JsonNode, out);
    return out;
}

function collectText(node: JsonNode, out: string[] = []): string[] {
    if (node === null || node === undefined) return out;
    if (typeof node === 'string' || typeof node === 'number') {
        out.push(String(node));
        return out;
    }
    if (Array.isArray(node)) {
        for (const entry of node) collectText(entry, out);
        return out;
    }
    if (node.children) collectText(node.children as JsonNode, out);
    return out;
}

describe('AgentInput effective authoring policy', () => {
    it('names the model the effective model policy resolves, not the raw prop fallback', async () => {
        const { AgentInput } = await import('./AgentInput');

        const { tree } = await renderScreen(React.createElement(AgentInput, {
            value: '',
            placeholder: 'placeholder',
            onChangeText: () => {},
            onSend: () => {},
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
            agentType: 'claude',
            agentLabel: 'Claude Code',
            modelMode: 'opus-4-6',
            modelOptionsOverride: [
                { value: 'default', label: 'Default', description: '' },
                { value: 'opus-4-6', label: 'Opus 4.6', description: 'Deep reasoning' },
            ],
            onModelModeChange: () => {},
        } as never));

        const nodes = flattenJson(tree!.toJSON() as JsonNode);
        const agentChip = nodes.find((node) => (node.props as any)?.testID === 'agent-input-agent-chip');
        expect(agentChip).toBeDefined();
        // Resolved through `describeEffectiveModelMode` + the model-option catalog:
        // the chip names the selected model, never the bare agent label.
        expect((agentChip!.props as any).accessibilityLabel).toBe('Opus 4.6');
        expect((agentChip!.props as any).accessibilityLabel).not.toBe('Claude Code');
    }, 90_000);

    it('badges the permission chip from the effective permission policy owner', async () => {
        const { AgentInput } = await import('./AgentInput');
        const { getPermissionModeBadgeLabelForAgentType } = await import(
            '@/sync/domains/permissions/permissionModeOptions'
        );

        const expectedBadge = getPermissionModeBadgeLabelForAgentType('claude', 'yolo');
        // Guards the assertion below from silently passing on an empty label.
        expect(expectedBadge.length).toBeGreaterThan(0);
        expect(getPermissionModeBadgeLabelForAgentType('claude', 'default')).toBe('');

        const { tree } = await renderScreen(React.createElement(AgentInput, {
            value: '',
            placeholder: 'placeholder',
            onChangeText: () => {},
            onSend: () => {},
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
            agentType: 'claude',
            permissionMode: 'yolo',
            onPermissionModeChange: () => {},
        } as never));

        const nodes = flattenJson(tree!.toJSON() as JsonNode);
        const permissionChip = nodes.find(
            (node) => (node.props as any)?.testID === 'agent-input-permission-chip',
        );
        expect(permissionChip).toBeDefined();
        expect(collectText(permissionChip as JsonNode)).toContain(expectedBadge);
    }, 90_000);
});
