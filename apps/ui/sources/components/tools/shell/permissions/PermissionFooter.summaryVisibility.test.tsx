import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { PermissionFooter } from '../permissions/PermissionFooter';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    TouchableOpacity: 'TouchableOpacity',
    ActivityIndicator: 'ActivityIndicator',
    Alert: { alert: vi.fn() },
    Platform: { OS: 'ios', select: <T,>(value: { ios?: T }) => value.ios },
    StyleSheet: { create: <T,>(styles: T) => styles },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: <T,>(styles: T) => styles },
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#000',
                textSecondary: '#666',
                permissionButton: {
                    allow: { background: '#0f0' },
                    deny: { background: '#f00' },
                    allowAll: { background: '#00f' },
                },
            },
        },
    }),
}));

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

vi.mock('@/sync/domains/state/storage', () => ({
    storage: { getState: () => ({ updateSessionPermissionMode: vi.fn() }) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

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
        await act(async () => {
            tree = renderer.create(
                React.createElement(PermissionFooter, {
                    permission: { id: 'p1', status: 'pending' },
                    sessionId: 's1',
                    toolName: 'Bash',
                    toolInput: { command: 'pwd' },
                    metadata: { flavor: 'opencode' },
                }),
            );
        });

        const texts = tree.root.findAllByType('Text' as any);
        const flattened = texts
            .map((t) => t.props.children)
            .flat()
            .filter((c) => typeof c === 'string') as string[];

        expect(flattened).not.toContain('SUMMARY');
        expect(flattened).toContain('common.yes');
    });
});
