import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { buildAgentInputActionMenuActions } from './actionMenuActions';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
    Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props, null),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: vi.fn(),
}));

vi.mock('@/agents/registry/compat/customAcp', () => ({
    resolveAgentLookupCoreConfig: () => ({ displayNameKey: 'agents.codex' }),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'claude', 'opencode', 'gemini'],
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ displayNameKey: 'agents.codex' }),
}));

describe('buildAgentInputActionMenuActions', () => {
    it('keeps machine/path entries in collapsed menu with fallback labels when values are empty', () => {
        const actions = buildAgentInputActionMenuActions({
            actionBarIsCollapsed: true,
            hasAnyActions: true,
            tint: '#fff',
            agentId: 'codex' as any,
            profileLabel: null,
            profileIcon: 'user-circle',
            machineName: undefined,
            currentPath: '',
            onMachineClick: () => {},
            onPathClick: () => {},
            dismiss: () => {},
            blurInput: () => {},
        });

        const machine = actions.find((action) => action.id === 'machine');
        const path = actions.find((action) => action.id === 'path');

        expect(machine?.label).toBe('newSession.selectMachineTitle');
        expect(path?.label).toBe('newSession.selectPathTitle');
    });

    it('keeps stop ahead of machine and path in the collapsed control menu order when only a resolved agent label is available', () => {
        const actions = buildAgentInputActionMenuActions({
            actionBarIsCollapsed: true,
            hasAnyActions: true,
            tint: '#fff',
            agentId: 'codex' as any,
            profileLabel: 'Default',
            profileIcon: 'user-circle',
            agentLabel: 'Configured backend',
            onAgentClick: () => {},
            onMachineClick: () => {},
            machineName: 'Builder',
            onPathClick: () => {},
            currentPath: '/tmp',
            canStop: true,
            onStop: () => {},
            dismiss: () => {},
            blurInput: () => {},
        });

        expect(actions.map((action) => action.id)).toEqual([
            'agent',
            'stop',
            'machine',
            'path',
        ]);

        expect(actions.find((action) => action.id === 'agent')?.label).toBe('Configured backend');
    });

    it('includes recipient and delivery extra controls in the collapsed control menu ahead of machine and path', () => {
        const opts = {
            actionBarIsCollapsed: true,
            hasAnyActions: true,
            tint: '#fff',
            agentId: 'codex' as any,
            profileLabel: 'Default',
            profileIcon: 'user-circle',
            agentLabel: 'Codex',
            onAgentClick: () => {},
            onMachineClick: () => {},
            machineName: 'Builder',
            onPathClick: () => {},
            currentPath: '/tmp',
            canStop: true,
            onStop: () => {},
            dismiss: () => {},
            blurInput: () => {},
            extraControlActions: {
                recipient: {
                    id: 'recipient',
                    label: 'Recipient',
                    icon: null,
                    onPress: () => {},
                },
                delivery: {
                    id: 'delivery',
                    label: 'Delivery',
                    icon: null,
                    onPress: () => {},
                },
            },
        } as Parameters<typeof buildAgentInputActionMenuActions>[0];

        const actions = buildAgentInputActionMenuActions(opts);

        expect(actions.map((action) => action.id)).toEqual([
            'agent',
            'stop',
            'recipient',
            'delivery',
            'machine',
            'path',
        ]);
    });

    it('keeps no, one, or many plugin controls after incumbent host groups in the collapsed menu', () => {
        const base = {
            actionBarIsCollapsed: true,
            hasAnyActions: true,
            tint: '#fff',
            agentId: 'codex' as any,
            profileLabel: 'Default',
            profileIcon: 'user-circle',
            agentLabel: 'Codex',
            onAgentClick: () => {},
            onMachineClick: () => {},
            machineName: 'Builder',
            onPathClick: () => {},
            currentPath: '/tmp',
            dismiss: () => {},
            blurInput: () => {},
        } as const;

        expect(buildAgentInputActionMenuActions(base).map((action) => action.id)).toEqual([
            'agent',
            'machine',
            'path',
        ]);

        expect(buildAgentInputActionMenuActions({
            ...base,
            extraControlActions: {
                'plugin:fixture/only': {
                    id: 'plugin:fixture/only',
                    label: 'Only plugin control',
                    icon: null,
                    onPress: () => {},
                },
            },
        }).map((action) => action.id)).toEqual([
            'agent',
            'machine',
            'path',
            'plugin:fixture/only',
        ]);

        expect(buildAgentInputActionMenuActions({
            ...base,
            extraControlActions: {
                'plugin:fixture/second': {
                    id: 'plugin:fixture/second',
                    label: 'Second plugin control',
                    icon: null,
                    onPress: () => {},
                },
                'plugin:fixture/first': {
                    id: 'plugin:fixture/first',
                    label: 'First plugin control',
                    icon: null,
                    onPress: () => {},
                },
            },
        }).map((action) => action.id)).toEqual([
            'agent',
            'machine',
            'path',
            'plugin:fixture/second',
            'plugin:fixture/first',
        ]);
    });

    it('places attachments ahead of machine and path in the collapsed control menu order', () => {
        const actions = buildAgentInputActionMenuActions({
            actionBarIsCollapsed: true,
            hasAnyActions: true,
            tint: '#fff',
            agentId: 'codex' as any,
            profileLabel: 'Default',
            profileIcon: 'user-circle',
            agentLabel: 'Codex',
            onAgentClick: () => {},
            extraControlActions: {
                attachments: {
                    id: 'attachments',
                    label: 'Attach',
                    icon: null,
                    onPress: () => {},
                },
            },
            onMachineClick: () => {},
            machineName: 'Builder',
            onPathClick: () => {},
            currentPath: '/tmp',
            dismiss: () => {},
            blurInput: () => {},
        });

        expect(actions.map((action) => action.id)).toEqual([
            'agent',
            'attachments',
            'machine',
            'path',
        ]);
    });

    it('places files ahead of machine and path in the collapsed control menu order', () => {
        const actions = buildAgentInputActionMenuActions({
            actionBarIsCollapsed: true,
            hasAnyActions: true,
            tint: '#fff',
            agentId: 'codex' as any,
            profileLabel: 'Default',
            profileIcon: 'user-circle',
            agentLabel: 'Codex',
            onAgentClick: () => {},
            sessionId: 'session-1',
            onFileViewerPress: () => {},
            onMachineClick: () => {},
            machineName: 'Builder',
            onPathClick: () => {},
            currentPath: '/tmp',
            dismiss: () => {},
            blurInput: () => {},
        });

        expect(actions.map((action) => action.id)).toEqual([
            'agent',
            'files',
            'machine',
            'path',
        ]);
    });

    it('places linked files ahead of machine and path in the collapsed control menu order', () => {
        const actions = buildAgentInputActionMenuActions({
            actionBarIsCollapsed: true,
            hasAnyActions: true,
            tint: '#fff',
            agentId: 'codex' as any,
            profileLabel: 'Default',
            profileIcon: 'user-circle',
            agentLabel: 'Codex',
            onAgentClick: () => {},
            extraControlActions: {
                linkedFiles: {
                    id: 'linked-files',
                    label: 'common.linkFile',
                    icon: null,
                    onPress: () => {},
                },
            },
            onMachineClick: () => {},
            machineName: 'Builder',
            onPathClick: () => {},
            currentPath: '/tmp',
            dismiss: () => {},
            blurInput: () => {},
        });

        expect(actions.map((action) => action.id)).toEqual([
            'agent',
            'linked-files',
            'machine',
            'path',
        ]);
    });

    it('places review comments ahead of machine and path in the collapsed control menu order', () => {
        const actions = buildAgentInputActionMenuActions({
            actionBarIsCollapsed: true,
            hasAnyActions: true,
            tint: '#fff',
            agentId: 'codex' as any,
            profileLabel: 'Default',
            profileIcon: 'user-circle',
            agentLabel: 'Codex',
            onAgentClick: () => {},
            extraControlActions: {
                reviewComments: {
                    id: 'review-comments',
                    label: '1 draft review comment',
                    icon: null,
                    onPress: () => {},
                },
            },
            onMachineClick: () => {},
            machineName: 'Builder',
            onPathClick: () => {},
            currentPath: '/tmp',
            dismiss: () => {},
            blurInput: () => {},
        });

        expect(actions.map((action) => action.id)).toEqual([
            'agent',
            'review-comments',
            'machine',
            'path',
        ]);
    });

    it('places connected services ahead of machine and path in the collapsed control menu order', () => {
        const actions = buildAgentInputActionMenuActions({
            actionBarIsCollapsed: true,
            hasAnyActions: true,
            tint: '#fff',
            agentId: 'codex' as any,
            profileLabel: 'Default',
            profileIcon: 'user-circle',
            agentLabel: 'Codex',
            onAgentClick: () => {},
            extraControlActions: {
                connectedServices: {
                    id: 'connected-services',
                    label: 'connectedServices.authChip.label',
                    icon: null,
                    onPress: () => {},
                },
            },
            onMachineClick: () => {},
            machineName: 'Builder',
            onPathClick: () => {},
            currentPath: '/tmp',
            dismiss: () => {},
            blurInput: () => {},
        });

        expect(actions.map((action) => action.id)).toEqual([
            'agent',
            'connected-services',
            'machine',
            'path',
        ]);
    });

    it('places storage ahead of machine and path in the collapsed control menu order', () => {
        const actions = buildAgentInputActionMenuActions({
            actionBarIsCollapsed: true,
            hasAnyActions: true,
            tint: '#fff',
            agentId: 'codex' as any,
            profileLabel: 'Default',
            profileIcon: 'user-circle',
            agentLabel: 'Codex',
            onAgentClick: () => {},
            extraControlActions: {
                storage: {
                    id: 'storage',
                    label: 'sessionsList.storageDirectTab',
                    icon: null,
                    onPress: () => {},
                },
            },
            onMachineClick: () => {},
            machineName: 'Builder',
            onPathClick: () => {},
            currentPath: '/tmp',
            dismiss: () => {},
            blurInput: () => {},
        });

        expect(actions.map((action) => action.id)).toEqual([
            'agent',
            'storage',
            'machine',
            'path',
        ]);
    });

    it('places grouped shortcut actions ahead of machine and path in the collapsed control menu order', () => {
        const actions = buildAgentInputActionMenuActions({
            actionBarIsCollapsed: true,
            hasAnyActions: true,
            tint: '#fff',
            agentId: 'codex' as any,
            profileLabel: 'Default',
            profileIcon: 'user-circle',
            agentLabel: 'Codex',
            onAgentClick: () => {},
            extraControlActions: {
                shortcuts: [
                    {
                        id: 'session-action:review.start',
                        label: 'Review',
                        icon: null,
                        onPress: () => {},
                    },
                    {
                        id: 'session-action:subagents.delegate.start',
                        label: 'Delegate',
                        icon: null,
                        onPress: () => {},
                    },
                ],
            },
            onMachineClick: () => {},
            machineName: 'Builder',
            onPathClick: () => {},
            currentPath: '/tmp',
            dismiss: () => {},
            blurInput: () => {},
        });

        expect(actions.map((action) => action.id)).toEqual([
            'agent',
            'session-action:review.start',
            'session-action:subagents.delegate.start',
            'machine',
            'path',
        ]);
    });

    it('places mcp ahead of machine and path in the collapsed control menu order', () => {
        const actions = buildAgentInputActionMenuActions({
            actionBarIsCollapsed: true,
            hasAnyActions: true,
            tint: '#fff',
            agentId: 'codex' as any,
            profileLabel: 'Default',
            profileIcon: 'user-circle',
            agentLabel: 'Codex',
            onAgentClick: () => {},
            extraControlActions: {
                mcp: {
                    id: 'new-session-mcp',
                    label: 'newSession.mcpChipLabel',
                    icon: null,
                    onPress: () => {},
                },
            },
            onMachineClick: () => {},
            machineName: 'Builder',
            onPathClick: () => {},
            currentPath: '/tmp',
            dismiss: () => {},
            blurInput: () => {},
        });

        expect(actions.map((action) => action.id)).toEqual([
            'agent',
            'new-session-mcp',
            'machine',
            'path',
        ]);
    });

    it('places automation ahead of machine and path in the collapsed control menu order', () => {
        const actions = buildAgentInputActionMenuActions({
            actionBarIsCollapsed: true,
            hasAnyActions: true,
            tint: '#fff',
            agentId: 'codex' as any,
            profileLabel: 'Default',
            profileIcon: 'user-circle',
            agentLabel: 'Codex',
            onAgentClick: () => {},
            extraControlActions: {
                automation: {
                    id: 'new-session-automate',
                    label: 'newSession.automationChip.default',
                    icon: null,
                    onPress: () => {},
                },
            },
            onMachineClick: () => {},
            machineName: 'Builder',
            onPathClick: () => {},
            currentPath: '/tmp',
            dismiss: () => {},
            blurInput: () => {},
        });

        expect(actions.map((action) => action.id)).toEqual([
            'agent',
            'new-session-automate',
            'machine',
            'path',
        ]);
    });

    it('places mode directly after engine in the collapsed control menu order', () => {
        const actions = buildAgentInputActionMenuActions({
            actionBarIsCollapsed: true,
            hasAnyActions: true,
            tint: '#fff',
            agentId: 'codex' as any,
            profileLabel: 'Default',
            profileIcon: 'user-circle',
            agentLabel: 'Codex',
            onAgentClick: () => {},
            sessionModeLabel: 'Build',
            onSessionModeClick: () => {},
            canStop: true,
            onStop: () => {},
            dismiss: () => {},
            blurInput: () => {},
        });

        expect(actions.map((action) => action.id)).toEqual([
            'agent',
            'mode',
            'stop',
        ]);
        expect((actions[1]?.icon as any)?.props?.name).toBe('rocket-launch');
    });
});
