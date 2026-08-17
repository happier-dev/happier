import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type {
    PluginInvocationLogRecordV1,
} from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';

import type { PluginInvocationLogsControllerState } from './pluginInvocationLogsController';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key) => {
                const translations: Readonly<Record<string, string>> = {
                    'settingsPlugins.invocationLogs.title': 'Invocation logs',
                    'settingsPlugins.invocationLogs.footer': 'Bounded redacted records from the selected machine.',
                    'settingsPlugins.invocationLogs.correlationFilter': 'Correlation ID filter',
                    'settingsPlugins.invocationLogs.correlationFilterAll': 'All invocations for this plugin',
                    'settingsPlugins.invocationLogs.refresh': 'Refresh logs',
                    'settingsPlugins.invocationLogs.follow': 'Follow logs',
                    'settingsPlugins.invocationLogs.stopFollowing': 'Stop following',
                    'settingsPlugins.invocationLogs.loadMore': 'Load next records',
                    'settingsPlugins.invocationLogs.loadingTitle': 'Loading invocation logs',
                    'settingsPlugins.invocationLogs.emptyTitle': 'No invocation logs',
                    'settingsPlugins.invocationLogs.emptySubtitle': 'No matching redacted records are available on this selected machine.',
                    'settingsPlugins.invocationLogs.unavailableTitle': 'Invocation logs unavailable',
                    'settingsPlugins.invocationLogs.unavailableSubtitle': 'The selected plugin machine is unavailable or is no longer current.',
                    'settingsPlugins.invocationLogs.readerUnavailableSubtitle': 'The selected plugin machine cannot provide invocation logs right now.',
                    'settingsPlugins.invocationLogs.selectionRequiredTitle': 'Select a plugin machine',
                    'settingsPlugins.invocationLogs.conflictTitle': 'Resolve the selected plugin machine',
                    'settingsPlugins.invocationLogs.errorTitle': 'Could not load invocation logs',
                    'settingsPlugins.invocationLogs.noMessage': 'Plugin log event',
                    'settingsPlugins.invocationLogs.level.info': 'Info',
                };
                return translations[key] ?? key;
            },
        });
    },
});

const PLUGIN_ID = 'acme.tools';

function createRecord(input: Readonly<{
    message?: string;
    correlationId?: string;
    sequence?: number;
}> = {}): PluginInvocationLogRecordV1 {
    const record: PluginInvocationLogRecordV1 = {
        version: 1,
        kind: 'plugin_invocation_log',
        level: 'info',
        message: 'The host-redacted message',
        fields: { apiToken: 'must-not-render-field-secret' },
        diagnostic: { nested: { token: 'must-not-render-diagnostic-secret' } },
        context: {
            plugin: { id: PLUGIN_ID, version: '1.0.0' },
            contribution: { id: 'action.run', qualifiedId: 'acme.tools/action.run' },
            generation: 'generation-1',
            correlationId: 'correlation-1',
            surface: 'action',
        },
        occurredAtMs: 1_715_000_000_000,
        sequence: 7,
    };
    return {
        ...record,
        message: input.message ?? record.message,
        context: {
            ...record.context,
            correlationId: input.correlationId ?? record.context.correlationId,
        },
        sequence: input.sequence ?? record.sequence,
    };
}

function expectedRowIdentity(record: PluginInvocationLogRecordV1): string {
    return [
        record.context.plugin.id,
        record.context.generation,
        record.context.correlationId,
        String(record.sequence),
    ].map((part) => `${part.length}:${part}`).join('|');
}

function createState(overrides: Partial<PluginInvocationLogsControllerState> = {}): PluginInvocationLogsControllerState {
    return {
        phase: 'ready',
        unavailableReason: null,
        correlationId: '',
        records: [],
        cursor: 20,
        hasMore: false,
        following: false,
        ...overrides,
    };
}

function createActions() {
    return {
        onEditCorrelationId: vi.fn(),
        onRefresh: vi.fn(),
        onLoadMore: vi.fn(),
        onStartFollowing: vi.fn(),
        onStopFollowing: vi.fn(),
    };
}

describe('PluginDetailInvocationLogsSectionView', () => {
    it('renders canonical redacted message and stamped metadata without rendering field or diagnostic payloads', async () => {
        const { PluginDetailInvocationLogsSectionView } = await import('./PluginDetailInvocationLogsSection');
        const screen = await renderScreen(
            <PluginDetailInvocationLogsSectionView
                pluginId={PLUGIN_ID}
                targetStatus="ready"
                state={createState({ records: [createRecord()] })}
                {...createActions()}
            />,
        );

        expect(screen.getTextContent()).toContain('The host-redacted message');
        expect(screen.getTextContent()).toContain('acme.tools/action.run');
        expect(screen.getTextContent()).toContain('correlation-1');
        expect(screen.getTextContent()).not.toContain('must-not-render-field-secret');
        expect(screen.getTextContent()).not.toContain('must-not-render-diagnostic-secret');
    });

    it('keeps same-sequence records from interleaved invocations distinct through reorder and removal', async () => {
        const {
            PluginDetailInvocationLogsSectionView,
            pluginInvocationLogRowIdentity,
        } = await import('./PluginDetailInvocationLogsSection');
        const first = createRecord({
            message: 'First invocation record',
            correlationId: 'correlation-first',
            sequence: 7,
        });
        const second = createRecord({
            message: 'Second invocation record',
            correlationId: 'correlation-second',
            sequence: 7,
        });
        const renderView = (records: readonly PluginInvocationLogRecordV1[]) => (
            <PluginDetailInvocationLogsSectionView
                pluginId={PLUGIN_ID}
                targetStatus="ready"
                state={createState({ records })}
                {...createActions()}
            />
        );
        expect(pluginInvocationLogRowIdentity(first)).toBe(expectedRowIdentity(first));
        expect(pluginInvocationLogRowIdentity(second)).toBe(expectedRowIdentity(second));
        expect(pluginInvocationLogRowIdentity(first)).not.toBe(pluginInvocationLogRowIdentity(second));
        const firstTestID = `settings.plugins.detail.${PLUGIN_ID}.invocationLogs.record.${pluginInvocationLogRowIdentity(first)}`;
        const secondTestID = `settings.plugins.detail.${PLUGIN_ID}.invocationLogs.record.${pluginInvocationLogRowIdentity(second)}`;
        const screen = await renderScreen(renderView([first, second]));

        expect(screen.findByTestId(firstTestID)).not.toBeNull();
        expect(screen.findByTestId(secondTestID)).not.toBeNull();
        expect(screen.getTextContent()).toContain('First invocation record');
        expect(screen.getTextContent()).toContain('Second invocation record');

        await act(async () => {
            screen.tree.update(renderView([second, first]));
        });
        expect(screen.findByTestId(firstTestID)).not.toBeNull();
        expect(screen.findByTestId(secondTestID)).not.toBeNull();
        expect(screen.getTextContent()).toContain('First invocation record');
        expect(screen.getTextContent()).toContain('Second invocation record');

        await act(async () => {
            screen.tree.update(renderView([second]));
        });
        expect(screen.findByTestId(firstTestID)).toBeNull();
        expect(screen.findByTestId(secondTestID)).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('First invocation record');
        expect(screen.getTextContent()).toContain('Second invocation record');
    });

    it('shows the canonical selected machine and server presentation inside the log group', async () => {
        const { PluginDetailInvocationLogsSectionView } = await import('./PluginDetailInvocationLogsSection');
        const screen = await renderScreen(
            <PluginDetailInvocationLogsSectionView
                pluginId={PLUGIN_ID}
                targetStatus="ready"
                targetPresentation={{
                    title: 'machine-2',
                    subtitle: 'srv_plugin_logs',
                    detail: 'Version 1.0.0',
                    selected: true,
                }}
                state={createState()}
                {...createActions()}
            />,
        );

        const target = screen.findByTestId(`settings.plugins.detail.${PLUGIN_ID}.invocationLogs.target`);
        expect(target).not.toBeNull();
        expect(target?.props.accessibilityState).toMatchObject({ selected: true });
        expect(screen.getTextContent()).toContain('machine-2');
        expect(screen.getTextContent()).toContain('srv_plugin_logs');
        expect(screen.getTextContent()).toContain('Version 1.0.0');
    });

    it('keeps loading, empty, error, and exact-target admission states distinct from one another', async () => {
        const { PluginDetailInvocationLogsSectionView } = await import('./PluginDetailInvocationLogsSection');
        const actions = createActions();

        const loading = await renderScreen(
            <PluginDetailInvocationLogsSectionView
                pluginId={PLUGIN_ID}
                targetStatus="ready"
                state={createState({ phase: 'loading' })}
                {...actions}
            />,
        );
        expect(loading.getTextContent()).toContain('Loading invocation logs');
        expect(loading.getTextContent()).not.toContain('No invocation logs');

        const empty = await renderScreen(
            <PluginDetailInvocationLogsSectionView
                pluginId={PLUGIN_ID}
                targetStatus="ready"
                state={createState()}
                {...actions}
            />,
        );
        expect(empty.getTextContent()).toContain('No invocation logs');

        const error = await renderScreen(
            <PluginDetailInvocationLogsSectionView
                pluginId={PLUGIN_ID}
                targetStatus="ready"
                state={createState({ phase: 'error' })}
                {...actions}
            />,
        );
        expect(error.getTextContent()).toContain('Could not load invocation logs');

        const selectionRequired = await renderScreen(
            <PluginDetailInvocationLogsSectionView
                pluginId={PLUGIN_ID}
                targetStatus="selectionRequired"
                state={createState({ phase: 'idle' })}
                {...actions}
            />,
        );
        expect(selectionRequired.getTextContent()).toContain('Select a plugin machine');
        expect(selectionRequired.getTextContent()).not.toContain('No invocation logs');
    });

    it('explains an unavailable selected log reader without misreporting the machine as stale', async () => {
        const { PluginDetailInvocationLogsSectionView } = await import('./PluginDetailInvocationLogsSection');
        const state = createState({
            phase: 'unavailable',
            unavailableReason: 'readerUnavailable',
        });
        const screen = await renderScreen(
            <PluginDetailInvocationLogsSectionView
                pluginId={PLUGIN_ID}
                targetStatus="ready"
                state={state}
                {...createActions()}
            />,
        );

        expect(screen.getTextContent()).toContain('Invocation logs unavailable');
        expect(screen.getTextContent()).toContain('The selected plugin machine cannot provide invocation logs right now.');
        expect(screen.getTextContent()).not.toContain('The selected plugin machine is unavailable or is no longer current.');
    });

    it('keeps a prior redacted window visible while clearly surfacing a refresh failure', async () => {
        const { PluginDetailInvocationLogsSectionView } = await import('./PluginDetailInvocationLogsSection');
        const screen = await renderScreen(
            <PluginDetailInvocationLogsSectionView
                pluginId={PLUGIN_ID}
                targetStatus="ready"
                state={createState({
                    phase: 'error',
                    records: [createRecord({ message: 'Last known redacted record' })],
                    hasMore: true,
                })}
                {...createActions()}
            />,
        );

        expect(screen.getTextContent()).toContain('Could not load invocation logs');
        expect(screen.getTextContent()).toContain('Last known redacted record');
        expect(screen.findByTestId(`settings.plugins.detail.${PLUGIN_ID}.invocationLogs.loadMore`)).not.toBeNull();
    });

    it('exposes bounded pagination and a stop action for an active follow', async () => {
        const { PluginDetailInvocationLogsSectionView } = await import('./PluginDetailInvocationLogsSection');
        const actions = createActions();
        const page = await renderScreen(
            <PluginDetailInvocationLogsSectionView
                pluginId={PLUGIN_ID}
                targetStatus="ready"
                state={createState({ hasMore: true })}
                {...actions}
            />,
        );

        await act(async () => {
            page.pressByTestId(`settings.plugins.detail.${PLUGIN_ID}.invocationLogs.loadMore`);
            page.pressByTestId(`settings.plugins.detail.${PLUGIN_ID}.invocationLogs.follow`);
        });
        expect(actions.onLoadMore).toHaveBeenCalledOnce();
        expect(actions.onStartFollowing).toHaveBeenCalledOnce();

        const following = await renderScreen(
            <PluginDetailInvocationLogsSectionView
                pluginId={PLUGIN_ID}
                targetStatus="ready"
                state={createState({ following: true })}
                {...actions}
            />,
        );
        await act(async () => {
            following.pressByTestId(`settings.plugins.detail.${PLUGIN_ID}.invocationLogs.stopFollowing`);
        });
        expect(actions.onStopFollowing).toHaveBeenCalledOnce();
    });
});
