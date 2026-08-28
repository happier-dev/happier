import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
    AutomationStoredDefinitionExecutionRecipeV1Schema,
    AutomationTriggerIdSchema,
} from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { createPassThroughComponent, createPassThroughModule } from '@/dev/testkit/mocks/components';
import type { AutomationEditorDraft } from '@/sync/domains/automations/automationEditorDraft';

import { installAutomationComponentCommonModuleMocks } from '../automationComponentTestHelpers';

installAutomationComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: createPassThroughComponent('View'),
            Pressable: createPassThroughComponent('Pressable'),
            Platform: {
                OS: 'web',
                select: <T,>(value: { web?: T; default?: T; ios?: T; android?: T }) => (
                    value.web ?? value.default ?? value.ios ?? value.android
                ),
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));
vi.mock('@/components/ui/lists/Item', () => createPassThroughModule(['Item']));
vi.mock('@/components/ui/lists/ItemGroupColumns', () => createPassThroughModule(['ItemGroupColumns', 'ItemGroupColumn']));
vi.mock('@/components/ui/forms/Switch', () => createPassThroughModule(['Switch']));
vi.mock('@/components/ui/forms/FieldItem', () => createPassThroughModule(['FieldItem']));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => createPassThroughModule(['DropdownMenu']));
vi.mock('@/components/ui/selectionList', () => createPassThroughModule(['SelectionList']));
vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text', 'TextInput']));
vi.mock('@/components/ui/icons/Icon', () => createPassThroughModule(['Icon']));
vi.mock('@/components/ui/popover', () => ({ usePopoverBoundaryRef: () => ({ current: null }) }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn(async () => true) } }));
vi.mock('./AutomationRecipeComposer', () => createPassThroughModule(['AutomationRecipeComposer']));

function createDraft(): AutomationEditorDraft {
    return {
        automationId: 'automation-1',
        pendingAutomationId: null,
        expectedTemplateVersion: 4,
        removedTriggers: [],
        name: 'Ship notes',
        description: null,
        enabled: true,
        executionRecipe: AutomationStoredDefinitionExecutionRecipeV1Schema.parse({
            v: 1,
            templateVersion: 4,
            template: { t: 'plain', v: { v: 1, prompt: 'Ship notes' } },
            triggerEvidence: null,
            target: {
                kind: 'newSession',
                spawn: {
                    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                    directory: '/workspace',
                    agentTarget: {
                        kind: 'agent',
                        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                    },
                },
            },
        }),
        assignments: [],
        triggers: [
            {
                clientId: 'schedule-a',
                persisted: { id: AutomationTriggerIdSchema.parse('trigger-schedule-a'), revision: 2 },
                definition: {
                    kind: 'schedule',
                    enabled: true,
                    schedule: { kind: 'interval', scheduleExpr: null, everyMs: 3_600_000, timezone: null },
                },
            },
            {
                clientId: 'schedule-b',
                persisted: { id: AutomationTriggerIdSchema.parse('trigger-schedule-b'), revision: 7 },
                definition: {
                    kind: 'schedule',
                    enabled: false,
                    schedule: { kind: 'cron', scheduleExpr: '0 9 * * 1-5', everyMs: null, timezone: 'UTC' },
                },
            },
            {
                clientId: 'turn-c',
                persisted: { id: AutomationTriggerIdSchema.parse('trigger-turn-c'), revision: 1 },
                definition: {
                    kind: 'sessionLifecycle',
                    enabled: true,
                    event: 'parentTurnCompleted',
                    scope: { kind: 'exactTurn', sourceSessionId: 'session-1', sourceTurnId: 'turn-1' },
                    consumption: 'once',
                },
            },
            {
                clientId: 'event-d',
                persisted: { id: AutomationTriggerIdSchema.parse('trigger-event-d'), revision: 11 },
                definition: {
                    kind: 'pluginEvent',
                    enabled: true,
                    eventRef: { pluginId: 'example.github', localId: 'pull-request-opened-v1' },
                    sourceInstanceId: 'repository-42',
                    sourceContractVersion: 1,
                    sourceConfig: { v: 1, config: {} },
                    displayLabel: 'Pull request opened',
                    observationTransport: {
                        kind: 'checkpointedPull',
                        watcherMaterializationRef: {
                            machineId: 'machine-1',
                            pluginId: 'example.github',
                            materializationId: 'materialization-1',
                        },
                    },
                    filter: null,
                    maximumObservationAgeMs: null,
                },
            },
        ],
    };
}

describe('AutomationPluralEditorScreen', () => {
    it('renders every trigger independently without selecting a representative trigger', async () => {
        const { AutomationPluralEditorScreen } = await import('./AutomationPluralEditorScreen');
        const screen = await renderScreen(
            <AutomationPluralEditorScreen
                variant="edit"
                value={createDraft()}
                onChange={() => {}}
            />,
        );

        expect(screen.findAllByProps({ testID: /^automation-trigger-row-/ })).toHaveLength(4);
        expect(screen.findByProps({ testID: 'automation-trigger-enabled-schedule-a' }).props.value).toBe(true);
        expect(screen.findByProps({ testID: 'automation-trigger-enabled-schedule-b' }).props.value).toBe(false);
        expect(screen.findByProps({ testID: 'automation-trigger-enabled-turn-c' }).props.value).toBe(true);
        expect(screen.findByProps({ testID: 'automation-trigger-enabled-event-d' }).props.value).toBe(true);
    });

    it('changes one trigger enablement while preserving its client and persisted identity', async () => {
        const { AutomationPluralEditorScreen } = await import('./AutomationPluralEditorScreen');
        const onChange = vi.fn();
        const draft = createDraft();
        const screen = await renderScreen(
            <AutomationPluralEditorScreen variant="edit" value={draft} onChange={onChange} />,
        );

        await act(async () => {
            screen.findByProps({ testID: 'automation-trigger-enabled-schedule-b' }).props.onValueChange(true);
        });

        const next = onChange.mock.calls[0]?.[0] as AutomationEditorDraft;
        expect(next.triggers).toHaveLength(4);
        expect(next.triggers[1]).toMatchObject({
            clientId: 'schedule-b',
            persisted: { id: 'trigger-schedule-b', revision: 7 },
            isDirty: true,
            definition: { kind: 'schedule', enabled: true },
        });
        expect(next.triggers[0]).toBe(draft.triggers[0]);
        expect(next.triggers[2]).toBe(draft.triggers[2]);
        expect(next.triggers[3]).toBe(draft.triggers[3]);
    });

    it('adds another schedule as a new stable row instead of replacing an existing schedule', async () => {
        const { AutomationPluralEditorScreen } = await import('./AutomationPluralEditorScreen');
        const onChange = vi.fn();
        const screen = await renderScreen(
            <AutomationPluralEditorScreen variant="edit" value={createDraft()} onChange={onChange} />,
        );

        await act(async () => {
            screen.findByProps({ testID: 'automation-trigger-add' }).props.onPress();
        });
        await act(async () => {
            screen.findByProps({ testID: 'automation-trigger-kind-schedule' }).props.onPress();
        });

        const next = onChange.mock.calls[0]?.[0] as AutomationEditorDraft;
        expect(next.triggers).toHaveLength(5);
        expect(next.triggers.slice(0, 4).map((trigger) => trigger.clientId)).toEqual([
            'schedule-a',
            'schedule-b',
            'turn-c',
            'event-d',
        ]);
        expect(next.triggers[4]).toMatchObject({
            persisted: null,
            definition: { kind: 'schedule', enabled: true },
        });
    });

    it('retains the exact persisted revision witness when a trigger is removed', async () => {
        const { AutomationPluralEditorScreen } = await import('./AutomationPluralEditorScreen');
        const onChange = vi.fn();
        const screen = await renderScreen(
            <AutomationPluralEditorScreen variant="edit" value={createDraft()} onChange={onChange} />,
        );

        await act(async () => {
            screen.findByProps({ testID: 'automation-trigger-row-schedule-b' }).props.onPress();
        });
        await act(async () => {
            screen.findByProps({ testID: 'automation-trigger-remove' }).props.onPress();
        });
        await act(async () => {});

        const next = onChange.mock.calls[0]?.[0] as AutomationEditorDraft;
        expect(next.triggers.map((trigger) => trigger.clientId)).toEqual(['schedule-a', 'turn-c', 'event-d']);
        expect(next.removedTriggers).toEqual([{ id: 'trigger-schedule-b', revision: 7 }]);
    });

    it('edits one schedule in place while preserving every stable row identity', async () => {
        const { AutomationPluralEditorScreen } = await import('./AutomationPluralEditorScreen');
        const onChange = vi.fn();
        const original = createDraft();
        const screen = await renderScreen(
            <AutomationPluralEditorScreen variant="edit" value={original} onChange={onChange} />,
        );

        await act(async () => {
            screen.findByProps({ testID: 'automation-trigger-row-schedule-a' }).props.onPress();
        });
        await act(async () => {
            screen.findByProps({ testID: 'automation-trigger-interval-minutes' }).props.onChangeText('120');
        });

        const next = onChange.mock.calls.at(-1)?.[0] as AutomationEditorDraft;
        expect(next.triggers.map((trigger) => trigger.clientId)).toEqual([
            'schedule-a',
            'schedule-b',
            'turn-c',
            'event-d',
        ]);
        expect(next.triggers[0]).toMatchObject({
            clientId: 'schedule-a',
            persisted: { id: 'trigger-schedule-a', revision: 2 },
            isDirty: true,
            definition: {
                kind: 'schedule',
                schedule: { kind: 'interval', everyMs: 7_200_000 },
            },
        });
        expect(next.triggers[1]).toBe(original.triggers[1]);
        expect(next.triggers[2]).toBe(original.triggers[2]);
        expect(next.triggers[3]).toBe(original.triggers[3]);
    });

    it('keeps a zero-trigger Automation creatable and exposes keyboard and screen-reader semantics', async () => {
        const { AutomationPluralEditorScreen } = await import('./AutomationPluralEditorScreen');
        const onSubmit = vi.fn();
        const screen = await renderScreen(
            <AutomationPluralEditorScreen
                variant="create"
                value={{ ...createDraft(), automationId: null, pendingAutomationId: 'automation-new', expectedTemplateVersion: null, triggers: [] }}
                onChange={() => {}}
                onSubmit={onSubmit}
            />,
        );

        expect(screen.findAllByProps({ testID: /^automation-trigger-row-/ })).toHaveLength(0);
        const submit = screen.findByProps({ testID: 'automation-editor-submit' });
        expect(submit.props.accessibilityRole).toBe('button');
        expect(submit.props.accessibilityState).toEqual({ disabled: false, busy: false });
        await act(async () => submit.props.onPress());
        expect(onSubmit).toHaveBeenCalledTimes(1);

        await act(async () => {
            screen.findByProps({ testID: 'automation-trigger-add' }).props.onPress();
        });
        for (const kind of ['schedule', 'pluginEvent', 'sessionLifecycle']) {
            const choice = screen.findByProps({ testID: `automation-trigger-kind-${kind}` });
            expect(choice.props.accessibilityRole).toBe('button');
            expect(choice.props.accessibilityState).toBeUndefined();
        }
    });

    it('keeps target authoring with the outer Session composer in embedded mode', async () => {
        const { AutomationPluralEditorScreen } = await import('./AutomationPluralEditorScreen');
        const screen = await renderScreen(
            <AutomationPluralEditorScreen variant="embedded" value={createDraft()} onChange={() => {}} />,
        );

        expect(screen.findAllByType('AutomationRecipeComposer' as any)).toHaveLength(0);
        expect(screen.findByProps({ testID: 'automation-name' }).props.accessibilityLabel)
            .toBe('automations.form.labels.name');
        expect(screen.findByProps({ testID: 'automation-description' }).props.accessibilityLabel)
            .toBe('automations.form.labels.descriptionOptional');
    });

    it('gives each trigger enablement control a stable test id and a descriptive screen-reader name', async () => {
        const { AutomationPluralEditorScreen } = await import('./AutomationPluralEditorScreen');
        const screen = await renderScreen(
            <AutomationPluralEditorScreen variant="edit" value={createDraft()} onChange={() => {}} />,
        );

        const switches = createDraft().triggers.map((trigger) => (
            screen.findByProps({ testID: `automation-trigger-enabled-${trigger.clientId}` })
        ));
        expect(switches.map((control) => control.props.accessibilityLabel)).toEqual([
            expect.stringContaining('automations.pluralEditor.scheduleTitle'),
            expect.stringContaining('automations.pluralEditor.scheduleTitle'),
            expect.stringContaining('automations.pluralEditor.turnCompletedTitle'),
            expect.stringContaining('Pull request opened'),
        ]);
        expect(new Set(switches.map((control) => control.props.testID)).size).toBe(4);
    });

    it('uses the searchable virtualized SelectionList for exact-turn Session selection', async () => {
        const { AutomationPluralEditorScreen } = await import('./AutomationPluralEditorScreen');
        const screen = await renderScreen(
            <AutomationPluralEditorScreen
                variant="create"
                value={{ ...createDraft(), triggers: [] }}
                onChange={() => {}}
                sessionOptions={Array.from({ length: 75 }, (_, index) => ({
                    sessionId: `session-${index}`,
                    label: `Session ${index}`,
                    currentParentTurnId: `turn-${index}`,
                }))}
                resolveCurrentSessionTurn={(sessionId) => ({
                    sourceSessionId: sessionId,
                    sourceTurnId: `turn-${sessionId.slice('session-'.length)}`,
                })}
            />,
        );

        await act(async () => {
            screen.findByProps({ testID: 'automation-trigger-add' }).props.onPress();
        });
        await act(async () => {
            screen.findByProps({ testID: 'automation-trigger-kind-sessionLifecycle' }).props.onPress();
        });

        const picker = screen.findByProps({ testID: 'automation-lifecycle-session-picker' });
        expect(picker.props.rootStep.inputPlaceholder).toBe('sessionsList.searchSessionsPlaceholder');
        expect(picker.props.rootStep.sections[0].virtualization).toBe('force');
        expect(picker.props.rootStep.sections[0].options).toHaveLength(75);
    });

    it('refuses to silently retarget when the selected Session advances before activation', async () => {
        const { AutomationPluralEditorScreen } = await import('./AutomationPluralEditorScreen');
        const onChange = vi.fn();
        const onSessionSelectionStale = vi.fn();
        const screen = await renderScreen(
            <AutomationPluralEditorScreen
                variant="create"
                value={{ ...createDraft(), triggers: [] }}
                onChange={onChange}
                sessionOptions={[{
                    sessionId: 'session-source',
                    label: 'Release review',
                    currentParentTurnId: 'turn-observed',
                }]}
                resolveCurrentSessionTurn={() => ({
                    sourceSessionId: 'session-source',
                    sourceTurnId: 'turn-new-current',
                })}
                onSessionSelectionStale={onSessionSelectionStale}
            />,
        );

        await act(async () => {
            screen.findByProps({ testID: 'automation-trigger-add' }).props.onPress();
        });
        await act(async () => {
            screen.findByProps({ testID: 'automation-trigger-kind-sessionLifecycle' }).props.onPress();
        });
        await act(async () => {
            screen.findByProps({ testID: 'automation-lifecycle-session-picker' }).props.onSelect('session-source');
        });

        expect(onChange).not.toHaveBeenCalled();
        expect(onSessionSelectionStale).toHaveBeenCalledTimes(1);
        expect(screen.findByProps({ testID: 'automation-lifecycle-selection-stale' })).toBeDefined();

        await screen.update(
            <AutomationPluralEditorScreen
                variant="create"
                value={{ ...createDraft(), triggers: [] }}
                onChange={onChange}
                sessionOptions={[{
                    sessionId: 'session-source',
                    label: 'Release review',
                    currentParentTurnId: 'turn-new-current',
                }]}
                resolveCurrentSessionTurn={() => ({
                    sourceSessionId: 'session-source',
                    sourceTurnId: 'turn-new-current',
                })}
                onSessionSelectionStale={onSessionSelectionStale}
            />,
        );
        await act(async () => {
            screen.findByProps({ testID: 'automation-lifecycle-session-picker' }).props.onSelect('session-source');
        });

        const refreshed = onChange.mock.calls[0]?.[0] as AutomationEditorDraft;
        expect(refreshed.triggers).toHaveLength(1);
        expect(refreshed.triggers[0]?.definition).toMatchObject({
            kind: 'sessionLifecycle',
            scope: {
                sourceSessionId: 'session-source',
                sourceTurnId: 'turn-new-current',
            },
        });
    });

    it('rejoins the injected canonical Event editor with one strict trigger row', async () => {
        const { AutomationPluralEditorScreen } = await import('./AutomationPluralEditorScreen');
        const onChange = vi.fn();
        let complete: ((value: any) => void) | null = null;
        const screen = await renderScreen(
            <AutomationPluralEditorScreen
                variant="create"
                value={{ ...createDraft(), triggers: [] }}
                onChange={onChange}
                renderPluginEventEditor={(props) => {
                    complete = props.onComplete;
                    return <Text testID="canonical-plugin-event-editor">Event editor</Text>;
                }}
            />,
        );

        await act(async () => {
            screen.findByProps({ testID: 'automation-trigger-add' }).props.onPress();
        });
        await act(async () => {
            screen.findByProps({ testID: 'automation-trigger-kind-pluginEvent' }).props.onPress();
        });
        expect(screen.findByProps({ testID: 'canonical-plugin-event-editor' })).toBeDefined();

        await act(async () => {
            complete?.({
                kind: 'pluginEvent',
                enabled: true,
                eventRef: { pluginId: 'example.plugin', localId: 'event/opened' },
                sourceInstanceId: 'source-1',
                sourceContractVersion: 1,
                sourceConfig: { v: 1, config: {} },
                displayLabel: 'Issue opened',
                observationTransport: {
                    kind: 'checkpointedPull',
                    watcherMaterializationRef: {
                        machineId: 'machine-1',
                        machineInstallationId: 'installation-1',
                        pluginId: 'example.plugin',
                        materializationId: 'materialization-1',
                    },
                },
                filter: null,
                maximumObservationAgeMs: null,
            });
        });

        const next = onChange.mock.calls[0]?.[0] as AutomationEditorDraft;
        expect(next.triggers).toHaveLength(1);
        expect(next.triggers[0]).toMatchObject({
            persisted: null,
            definition: { kind: 'pluginEvent', displayLabel: 'Issue opened' },
        });
    });
});
