import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationPluginEventDefinitionTriggerInput } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
import { createPassThroughComponent, createPassThroughModule } from '@/dev/testkit/mocks/components';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: createPassThroughComponent('View'),
            Pressable: createPassThroughComponent('Pressable'),
            Platform: {
                OS: 'ios',
                select: <T,>(values: { ios?: T; android?: T; web?: T; default?: T }) => (
                    values.ios ?? values.default ?? values.android ?? values.web
                ),
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));
vi.mock('@/components/ui/lists/Item', () => createPassThroughModule(['Item']));
vi.mock('@/components/ui/lists/ItemGroupColumns', () => createPassThroughModule(['ItemGroupColumns', 'ItemGroupColumn']));
vi.mock('@/components/ui/forms/FieldItem', () => createPassThroughModule(['FieldItem']));
vi.mock('@/components/ui/forms/Switch', () => createPassThroughModule(['Switch']));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => createPassThroughModule(['DropdownMenu']));
vi.mock('@/components/ui/selectionList', () => createPassThroughModule(['SelectionList']));
vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text', 'TextInput']));
vi.mock('@/components/ui/icons/Icon', () => createPassThroughModule(['Icon']));
vi.mock('@/components/ui/popover', () => ({ usePopoverBoundaryRef: () => ({ current: null }) }));
vi.mock('@/components/automations/editor/PluginEventAutomationEditor', () => (
    createPassThroughModule(['PluginEventAutomationEditor'])
));

function createPluginEventDefinition(
    localId: string,
    sourceInstanceId: string,
    machineId: string,
): AutomationPluginEventDefinitionTriggerInput {
    return {
        kind: 'pluginEvent',
        enabled: true,
        eventRef: { pluginId: 'example.github', localId },
        sourceInstanceId,
        sourceContractVersion: 1,
        sourceConfig: { v: 1, config: {} },
        displayLabel: localId,
        observationTransport: {
            kind: 'checkpointedPull',
            watcherMaterializationRef: {
                machineId,
                pluginId: 'example.github',
                materializationId: `materialization-${machineId}`,
            },
        },
        filter: null,
        maximumObservationAgeMs: null,
    };
}

function createDraft(): NewSessionAutomationDraft {
    return {
        pendingAutomationId: 'automation-pending-1',
        enabled: true,
        name: 'Release watch',
        description: 'Keep the release moving',
        triggers: [
            {
                clientId: 'schedule-hourly',
                definition: {
                    kind: 'schedule',
                    enabled: true,
                    schedule: {
                        kind: 'interval',
                        scheduleExpr: null,
                        everyMs: 60 * 60_000,
                        timezone: null,
                    },
                },
            },
            {
                clientId: 'schedule-weekdays',
                definition: {
                    kind: 'schedule',
                    enabled: false,
                    schedule: {
                        kind: 'cron',
                        scheduleExpr: '0 9 * * 1-5',
                        everyMs: null,
                        timezone: 'UTC',
                    },
                },
            },
        ],
    };
}

export function runAutomationSettingsPopoverContentTests(): void {
    describe('AutomationSettingsPopoverContent', () => {
        it('edits independently enabled schedule rows while preserving their stable identities', async () => {
            const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
            const onChange = vi.fn();
            const screen = await renderScreen(
                <AutomationSettingsPopoverContent value={createDraft()} onChange={onChange} />,
            );

            expect(screen.findByProps({ testID: 'automation-plural-editor' })).toBeTruthy();
            expect(screen.findByProps({ testID: 'automation-name' }).props.value).toBe('Release watch');
            expect(screen.findAllByProps({ testID: /^automation-trigger-row-/ })).toHaveLength(2);
            expect(screen.findByProps({ testID: 'automation-trigger-enabled-schedule-hourly' }).props.value).toBe(true);
            expect(screen.findByProps({ testID: 'automation-trigger-enabled-schedule-weekdays' }).props.value).toBe(false);

            await act(async () => {
                screen.findByProps({ testID: 'automation-trigger-enabled-schedule-weekdays' }).props.onValueChange(true);
            });

            const enabledDraft = onChange.mock.calls.at(-1)?.[0] as NewSessionAutomationDraft;
            expect(enabledDraft.pendingAutomationId).toBe('automation-pending-1');
            expect(enabledDraft.triggers.map((trigger) => trigger.clientId)).toEqual([
                'schedule-hourly',
                'schedule-weekdays',
            ]);
            expect(enabledDraft.triggers[0]?.definition).toMatchObject({
                kind: 'schedule',
                enabled: true,
                schedule: { kind: 'interval', everyMs: 60 * 60_000 },
            });
            expect(enabledDraft.triggers[1]?.definition).toMatchObject({
                kind: 'schedule',
                enabled: true,
                schedule: { kind: 'cron', scheduleExpr: '0 9 * * 1-5' },
            });

            await act(async () => {
                screen.findByProps({ testID: 'automation-trigger-row-schedule-hourly' }).props.onPress();
            });
            await act(async () => {
                screen.findByProps({ testID: 'automation-trigger-interval-minutes' }).props.onChangeText('120');
            });

            const editedDraft = onChange.mock.calls.at(-1)?.[0] as NewSessionAutomationDraft;
            expect(editedDraft.triggers.map((trigger) => trigger.clientId)).toEqual([
                'schedule-hourly',
                'schedule-weekdays',
            ]);
            expect(editedDraft.triggers[0]?.definition).toMatchObject({
                kind: 'schedule',
                schedule: { kind: 'interval', everyMs: 120 * 60_000 },
            });
        });

        it('keeps a zero-trigger draft editable and exposes accessible Automation and trigger controls', async () => {
            const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
            const screen = await renderScreen(
                <AutomationSettingsPopoverContent
                    value={{
                        pendingAutomationId: 'automation-empty',
                        enabled: false,
                        name: '',
                        description: '',
                        triggers: [],
                    }}
                    onChange={() => {}}
                />,
            );

            expect(screen.findAllByProps({ testID: /^automation-trigger-row-/ })).toHaveLength(0);
            expect(screen.findByProps({ testID: 'automation-name' })).toBeTruthy();
            const automationToggle = screen.findAllByType('Switch' as any)[0];
            expect(automationToggle?.props.value).toBe(false);
            expect(automationToggle?.props.accessibilityLabel).toBe('automations.form.toggleEnabledTitle');
            expect(automationToggle?.props.accessibilityHint).toBe('automations.pluralEditor.enabledSubtitle');

            await act(async () => {
                screen.findByProps({ testID: 'automation-trigger-add' }).props.onPress();
            });
            for (const kind of ['schedule', 'pluginEvent', 'sessionLifecycle']) {
                const option = screen.findByProps({ testID: `automation-trigger-kind-${kind}` });
                expect(option.props.accessibilityRole).toBe('radio');
                expect(option.props.accessibilityState).toEqual({ selected: false });
            }
        });

        it('mounts the canonical Event editor for the exact active row and preserves sibling rows', async () => {
            const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
            const firstEvent = createPluginEventDefinition('push', 'repository-a', 'watcher-a');
            const activeEvent = createPluginEventDefinition('pull-request-opened', 'repository-b', 'watcher-b');
            const draft: NewSessionAutomationDraft = {
                pendingAutomationId: 'automation-event-pending',
                enabled: true,
                name: 'Repository watch',
                description: '',
                triggers: [
                    { clientId: 'event-a', definition: firstEvent },
                    { clientId: 'event-b', definition: activeEvent },
                ],
            };
            const onChange = vi.fn();
            const screen = await renderScreen(
                <AutomationSettingsPopoverContent
                    value={draft}
                    onChange={onChange}
                    machineId="fallback-machine"
                    targetServerId="server-1"
                />,
            );

            await act(async () => {
                screen.findByProps({ testID: 'automation-trigger-row-event-b' }).props.onPress();
            });

            const editor = screen.findByType('PluginEventAutomationEditor' as any);
            expect(editor.props).toEqual(expect.objectContaining({
                automationId: 'automation-event-pending',
                clientId: 'event-b',
                value: activeEvent,
                seed: null,
                authoringMachineId: 'fallback-machine',
                serverId: 'server-1',
            }));

            const editedEvent = {
                ...activeEvent,
                displayLabel: 'Pull request opened in repository B',
            } satisfies AutomationPluginEventDefinitionTriggerInput;
            await act(async () => {
                editor.props.onComplete(editedEvent);
            });

            const next = onChange.mock.calls.at(-1)?.[0] as NewSessionAutomationDraft;
            expect(next.triggers.map((trigger) => trigger.clientId)).toEqual(['event-a', 'event-b']);
            expect(next.triggers[0]?.definition).toBe(firstEvent);
            expect(next.triggers[1]?.definition).toEqual(editedEvent);
        });

        it('mounts a new row-scoped Event editor with the same machine and server context', async () => {
            const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
            const screen = await renderScreen(
                <AutomationSettingsPopoverContent
                    value={createDraft()}
                    onChange={() => {}}
                    machineId="machine-new"
                    targetServerId="server-new"
                />,
            );

            await act(async () => {
                screen.findByProps({ testID: 'automation-trigger-add' }).props.onPress();
            });
            await act(async () => {
                screen.findByProps({ testID: 'automation-trigger-kind-pluginEvent' }).props.onPress();
            });

            const editor = screen.findByType('PluginEventAutomationEditor' as any);
            expect(editor.props).toEqual(expect.objectContaining({
                automationId: 'automation-pending-1',
                clientId: 'new-plugin-event',
                value: null,
                seed: null,
                authoringMachineId: 'machine-new',
                serverId: 'server-new',
            }));
        });
    });
}
