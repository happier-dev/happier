import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';

import { PermissionFooter } from '../permissions/PermissionFooter';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            View: 'View',
            Text: 'Text',
            TouchableOpacity: 'TouchableOpacity',
            ActivityIndicator: 'ActivityIndicator',
            Alert: {
                alert: vi.fn(),
            },
            Platform: {
                OS: 'ios',
                select: <T,>(value: { ios?: T }) => value.ios,
            },
            StyleSheet: {
                create: <T,>(styles: T) => styles,
            },
        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/sync/ops', () => ({
    sessionAllow: vi.fn(async () => {}),
    sessionAllowWithPermissionUpdates: vi.fn(async () => {}),
    sessionDeny: vi.fn(async () => {}),
    sessionAbort: vi.fn(async () => {}),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: vi.fn(async () => {}),
    },
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: { getState: () => ({ updateSessionPermissionMode: vi.fn() }) },
});
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/agents/catalog/resolve', () => ({
    resolveAgentIdForPermissionUi: () => 'claude',
}));

vi.mock('@/agents/catalog/permissionUiCopy', () => ({
    getPermissionFooterCopy: () => ({
        protocol: 'claude',
        yesAllowAllEditsKey: 'claude.permissions.yesAllowAllEdits',
        yesForToolKey: 'claude.permissions.yesForTool',
        stopKey: 'claude.permissions.stop',
    }),
}));

vi.mock('@/components/tools/normalization/policy/permissionSummary', () => ({
    formatPermissionRequestSummary: () => 'SUMMARY',
}));

describe('PermissionFooter summary visibility', () => {
    it('does not repeat the request summary (the tool UI already shows it)', async () => {
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(PermissionFooter, {
                    permission: { id: 'p1', status: 'pending' },
                    sessionId: 's1',
                    toolName: 'Bash',
                    toolInput: { command: 'pwd' },
                    metadata: { flavor: 'opencode' },
                }))).tree;

        const texts = tree.root.findAllByType('Text' as any);
        const flattened = texts
            .map((t) => t.props.children)
            .flat()
            .filter((c) => typeof c === 'string') as string[];

        expect(flattened).not.toContain('SUMMARY');
        expect(flattened).toContain('common.yes');
    });
});
