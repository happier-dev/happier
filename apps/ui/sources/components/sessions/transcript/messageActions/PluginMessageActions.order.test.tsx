import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MessageActionReferenceV1 } from '@happier-dev/protocol';

import type {
    PluginProjectionAction,
    PluginProjectionEntry,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { renderScreen, standardCleanup } from '@/dev/testkit';

import {
    createPluginMessageActionHost,
    PluginMessageActionHostProvider,
    PluginMessageActions,
} from './PluginMessageActions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: <T,>(values: { ios?: T; native?: T; default?: T }) => (
                values.ios ?? values.native ?? values.default
            ),
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                state: { neutral: { background: '#eeeeee' } },
                text: { secondary: '#666666' },
            },
        },
    });
});

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
    ICON_SIZE: { xs: 14 },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: React.PropsWithChildren<Record<string, unknown>>) => (
        React.createElement('Text', props, props.children)
    ),
}));

const messageReference: MessageActionReferenceV1 = {
    v: 1,
    sessionId: 'session-1',
    messageId: 'message-1',
    observedRevision: 'revision-1',
};

function action(id: string): PluginProjectionAction {
    return {
        id,
        title: id,
        description: null,
        icon: null,
        scopes: ['message'],
        surfaces: ['ui'],
        placementBindings: ['rowAction'],
        inputSchema: null,
        inputHints: null,
        priority: null,
        dangerLevel: 'safe',
        confirmation: null,
        available: true,
    };
}

function entry(
    pluginId: string,
    actions: readonly PluginProjectionAction[] = [action('review')],
): PluginProjectionEntry {
    return {
        pluginId,
        title: pluginId,
        description: null,
        version: '1.0.0',
        enabled: true,
        generation: 7,
        generationLabel: '7',
        status: null,
        provenance: null,
        diagnostics: [],
        actions,
        resources: [],
        editableSettingsGroups: [],
    };
}

afterEach(() => {
    standardCleanup();
});

describe('PluginMessageActions row adapter', () => {
    it('uses qualified identity order even when the projection is rebuilt in a different insertion order', async () => {
        const host = createPluginMessageActionHost({
            resolveCurrent: () => ({
                // The canonical projection is a record, so its insertion order
                // is not a presentation contract for a transcript row.
                pluginProjectionById: {
                    'zeta.preview': entry('zeta.preview'),
                    'alpha.preview': entry('alpha.preview'),
                },
                host: {
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    expectedGeneration: 7,
                    sessionId: 'session-1',
                    isCurrent: () => true,
                },
            }),
            sessionId: 'session-1',
        });

        const screen = await renderScreen(
            <PluginMessageActionHostProvider host={host}>
                <PluginMessageActions
                    messageActionReference={messageReference}
                    invertedActionsLayout={false}
                />
            </PluginMessageActionHostProvider>,
        );

        expect(screen.findAllByType('Pressable')
            .map((node) => node.props.testID as string | undefined)
            .filter((testID): testID is string => testID?.startsWith('plugin-message-action:') === true),
        ).toEqual([
            'plugin-message-action:alpha.preview/review',
            'plugin-message-action:zeta.preview/review',
        ]);
    });

    it('uses declared Action priority and icon for plural message placement bindings', async () => {
        const later = Object.assign(action('review'), {
            placementBindings: ['rowAction'] as const,
            icon: 'arrow-right',
            priority: 10,
        });
        const earlier = Object.assign(action('review'), {
            placementBindings: ['rowAction'] as const,
            icon: 'magic-wand',
            priority: -10,
        });
        const host = createPluginMessageActionHost({
            resolveCurrent: () => ({
                pluginProjectionById: {
                    'alpha.preview': entry('alpha.preview', [later]),
                    'zeta.preview': entry('zeta.preview', [earlier]),
                },
                host: {
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    expectedGeneration: 7,
                    sessionId: 'session-1',
                    isCurrent: () => true,
                },
            }),
            sessionId: 'session-1',
        });

        const screen = await renderScreen(
            <PluginMessageActionHostProvider host={host}>
                <PluginMessageActions
                    messageActionReference={messageReference}
                    invertedActionsLayout={false}
                />
            </PluginMessageActionHostProvider>,
        );

        expect(screen.findAllByType('Pressable')
            .map((node) => node.props.testID as string | undefined)
            .filter((testID): testID is string => testID?.startsWith('plugin-message-action:') === true),
        ).toEqual([
            'plugin-message-action:zeta.preview/review',
            'plugin-message-action:alpha.preview/review',
        ]);
        expect(screen.findAllByType('Icon').map((node) => node.props.name)).toEqual([
            'magic-wand',
            'arrow-right',
        ]);
    });

    it('fails closed before reading the mounted projection for a different Session reference', () => {
        const resolveCurrent = vi.fn(() => {
            throw new Error('a cross-session Message row must not use this Session host');
        });
        const host = createPluginMessageActionHost({ resolveCurrent, sessionId: 'session-1' });

        expect(host.resolveCurrent({ ...messageReference, sessionId: 'other-session' })).toBeNull();
        expect(resolveCurrent).not.toHaveBeenCalled();
    });
});
