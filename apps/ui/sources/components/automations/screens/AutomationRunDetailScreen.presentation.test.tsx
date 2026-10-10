import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    AutomationOccurrenceKeyV1Schema,
    AutomationRunCauseSchema,
    materializeAutomationRunExecutionRecipeV1,
} from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
import { setPreferredLanguageFromSettings, t } from '@/text';
import * as presentation from './AutomationRunDetailScreen';

// Native/platform boundaries only: the screen's translator, recipe projection and Items stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }));

afterEach(() => setPreferredLanguageFromSettings(null));

function newSessionTarget(directory: Readonly<{ kind: 'path'; path: string }> | Readonly<{ kind: 'managed' }>) {
    const materialized = materializeAutomationRunExecutionRecipeV1({
        recipe: {
            v: 1,
            templateVersion: 1,
            assignmentMachineIds: ['machine-1'],
            template: { t: 'plain', v: { v: 1, prompt: 'Review the changes.' } },
            triggerEvidence: null,
            target: {
                kind: 'newSession',
                spawn: {
                    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                    directory,
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.ohmypi', localId: 'ohmypi' } },
                },
            },
        },
        accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
        cause: { kind: 'manual', invokedAt: 1 },
        runId: 'run-1',
    });
    if (materialized.kind !== 'available') throw new Error('Expected a valid new-session recipe fixture');
    return materialized.target;
}

function lifecycleCause(event: 'parentTurnCompleted' | 'sessionStarted' | 'sessionArchived') {
    const cause = AutomationRunCauseSchema.parse({
        kind: 'trigger',
        triggerId: 'trigger-1',
        triggerRevision: 1,
        triggerKind: 'sessionLifecycle',
        occurrenceKey: AutomationOccurrenceKeyV1Schema.parse('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
        occurredAt: 1,
        evidence: {
            event,
            sourceSessionId: 'session-1',
            ...(event === 'parentTurnCompleted' ? { sourceTurnId: 'turn-1' } : {}),
            policy: { kind: 'everyMatch' },
        },
    });
    if (cause.kind !== 'trigger' || cause.triggerKind !== 'sessionLifecycle') throw new Error('Expected a lifecycle cause fixture');
    return cause;
}

describe('frozen Run detail presentation', () => {
    it('offers authoring from exact retained event evidence without inventing a second activity feed', async () => {
        const { AutomationRunPluginEventTriggerEvidenceV1Schema } = await import('@happier-dev/protocol/automations/automationRunExecutionRecipeV1');
        const evidence = AutomationRunPluginEventTriggerEvidenceV1Schema.parse({
            v: 1, kind: 'pluginEvent', eventRef: { pluginId: 'acme.github', localId: 'issue-opened' },
            sourceSelectorId: '11111111-1111-4111-8111-111111111111', occurrenceId: 'github-delivery-1',
            occurredAt: 100, sourceInstanceId: 'repository:42', sourceContractVersion: 3,
            observationReceivedAt: 100, payload: { action: 'opened' }, filter: { version: 1, result: 'matched' },
        });
        const screen = await renderScreen(<presentation.AutomationRunDetailEvidenceItems evidence={evidence} />);
        expect(screen.findByTestId('automation-run-event-create-trigger')).toBeTruthy();
        expect(screen.getTextContent()).toContain('repository:42');
    });
    it('shows the admitted path rather than serializing its directory-intent object', () => {
        expect(presentation.formatRunTarget(newSessionTarget({ kind: 'path', path: '/work/project' })))
            .toBe(t('automations.detail.runDetail.newSession', { machineId: 'machine-1', directory: '/work/project' }));
    });

    it('shows a managed session as private without inventing its daemon-owned path', () => {
        expect(presentation.formatRunTarget(newSessionTarget({ kind: 'managed' })))
            .toBe(t('automations.detail.runDetail.newSession', {
                machineId: 'machine-1',
                directory: t('session.folderless.privateToSession'),
            }));
    });

    it.each(['parentTurnCompleted', 'sessionStarted', 'sessionArchived'] as const)(
        'shows the actual source context for %s without inventing a source turn',
        async (event) => {
            const screen = await renderScreen(<presentation.AutomationRunLifecycleCauseItems cause={lifecycleCause(event)} />);
            const text = screen.getTextContent();
            expect(text).toContain(t(`automations.pluralEditor.lifecycleEvent.${event}`));
            expect(text).toContain(t('automations.detail.trigger.sourceSession'));
            expect(text).toContain('session-1');
            if (event === 'parentTurnCompleted') {
                expect(text).toContain(t('automations.detail.trigger.sourceTurn'));
                expect(text).toContain('turn-1');
            } else {
                expect(text).not.toContain(t('automations.detail.trigger.sourceTurn'));
            }
        },
    );
});
