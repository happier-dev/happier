import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { storage } from '@/sync/domains/state/storage';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const runtime = installSessionPaneRuntimeTestHarness();
const { SessionCompanionScreen } = await import('./SessionCompanionScreen');
const { PaneHeaderSlotProvider, PaneHeaderSlotScope, usePublishedPaneHeaderContent } = await import('@/components/appShell/panes/paneHeaderSlot');
const { SessionCompanionAddControl } = await import('./picker/SessionCompanionAddControl');
const { buildCompanionWidgetAddSections } = await import('@/components/widgets/add/widgetAddSections');
const { selectWidgetCandidates } = await import('@/components/widgets/widgetCatalog');

function Header() {
    return <>{usePublishedPaneHeaderContent('companion')?.action}</>;
}

describe('full-height Companion header Machine binding', () => {
    it('offers Vitals following the recorded Session Machine through the real header Add path', async () => {
        const session = createSessionFixture({ id: 's1', serverId: runtime.serverId,
            metadata: { ...createSessionFixture().metadata!, machineId: 'recorded-machine' } });
        storage.getState().applySessions([session]);
        const screen = await renderScreen(<runtime.Wrapper><PaneHeaderSlotProvider>
            <Header /><PaneHeaderSlotScope slotKey="companion"><SessionCompanionScreen
                sessionId="s1" address={{ serverId: runtime.serverId, sessionId: 's1' }}
                onRequestClose={() => {}} onRevealBoardItem={() => {}}
            /></PaneHeaderSlotScope>
        </PaneHeaderSlotProvider></runtime.Wrapper>);
        const binding = screen.findAllByType(SessionCompanionAddControl)
            .find(control => control.props.testID === 'session-companion-screen-add')!.props.binding;
        const sections = buildCompanionWidgetAddSections({ ...binding, glanceCandidates: selectWidgetCandidates(null) });
        const vitals = sections.flatMap(section => section.entries).find(entry => entry.id === 'plugin-builtin:machine_vitals');
        expect(vitals).toBeDefined();
        const setup = vitals!.setup!();
        expect(setup.initial.bindings.machine).toEqual({ kind: 'context', slot: 'machine' });
        expect(setup.resolve(setup.initial)).toMatchObject({ status: 'ready', input: {
            machine: { serverId: runtime.serverId, machineId: 'recorded-machine' },
        } });
    });
});
