import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';

import type { WorkItem, WorkProjection, WorkStatus } from './workProjection';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

installSessionSubagentCommonModuleMocks({
    storage: () => vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage'),
});
afterEach(standardCleanup);

function report(sessionId: string, status: WorkStatus): WorkItem {
    return {
        key: `session:${sessionId}`,
        kind: 'session',
        title: sessionId,
        agentId: null,
        facts: [],
        parentKey: null,
        level: 0,
        status,
        progress: null,
        open: { kind: 'session', sessionId },
    };
}

describe('SessionWorkMapView', () => {
    it('opens the admitted command from its qualified Map node before an output terminal exists', async () => {
        const { SessionWorkMapView } = await import('./SessionWorkMapView');
        const { projectSessionWorkMap } = await import('./workMapProducer');
        const { projectWork } = await import('./workProjection');
        const projection = projectWork({
            sessionId: 'lead', serverId: 'home', accountId: 'account', reportSessions: [], agentEntries: [],
            workflowHeadlineRuns: [], managedRuns: [], ownTriggerRunIds: new Set(),
            describeAgentStatus: (entry) => entry.status, describeProgress: () => '',
            actionOperations: [{ serverId: 'home', observation: 'available', isUnavailableProjection: false, snapshot: {
                version: 1, operationId: 'build', revision: 1, actionId: 'projects.script.run', state: 'accepted',
                scope: { accountId: 'account', machineId: 'machine', sessionId: 'lead' }, title: 'Build',
                createdAt: 1, cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'script',
                    serverId: 'home', machineId: 'machine', workspaceRefId: 'workspace', cwd: '/repo' },
            } }],
        });
        const command = projection.projectCommands[0];
        const map = projectSessionWorkMap({ managerSessionId: 'lead', leadTitle: 'Lead', projection });
        const onOpenItem = vi.fn();
        const screen = await renderScreen(<SessionWorkMapView map={map} projection={projection} showFacts testIDPrefix="work-map" onOpenItem={onOpenItem} />);
        const node = screen.findByTestId(`work-map-node-${command.key}`);
        expect(node).not.toBeNull();
        await pressTestInstanceAsync(node!);
        expect(onOpenItem).toHaveBeenCalledWith(command);
        await screen.unmount();
    }, 180_000);

    it('lets the shared treatment ring every node by its tone, a stalled report as much as one that needs you', async () => {
        // The mocks install at run time, so the renderer loads after them (a cold import is slow under load).
        const { SessionWorkMapView } = await import('./SessionWorkMapView');
        const { projectSessionWorkMap } = await import('./workMapProducer');
        const { workStatusSurfaceStyle } = await import('@/components/work/status/workStatusTreatment');
        const sessions = [
            report('stalled', { state: 'disconnected', bucket: 'offline', tone: 'attention', attentionType: null, word: 'Last seen 3h ago' }),
            report('asks', { state: 'permission_required', bucket: 'needs_you', tone: 'attention', attentionType: 'approval', word: 'Needs your permission' }),
            report('broke', { state: 'failed', bucket: 'needs_you', tone: 'danger', attentionType: 'blocked', word: 'Error' }),
            report('busy', { state: 'thinking', bucket: 'working', tone: 'neutral', attentionType: null, word: 'Working' }),
        ];
        const projection: WorkProjection = {
            sessions,
            workflows: [],
            backgroundRuns: [],
            agents: [],
            projectCommands: [],
            archivedSessions: [],
            summary: { outstanding: 4, needsYou: 2, stalled: 1, sessions: 4, runs: 0 },
        };
        const map = projectSessionWorkMap({ managerSessionId: 'lead', leadTitle: 'Lead', projection });
        const screen = await renderScreen(
            <SessionWorkMapView map={map} projection={projection} showFacts testIDPrefix="work-map" onOpenItem={vi.fn()} />,
        );

        const nodeStyles = (sessionId: string) => {
            const node = screen.findByTestId(`work-map-node-session:${sessionId}`);
            expect(node, sessionId).not.toBeNull();
            const style = node!.props.style;
            return [typeof style === 'function' ? style({ pressed: false }) : style].flat(Infinity);
        };

        // The shared map draws the one treatment (equal ring and tint, not necessarily the same entry).
        expect(nodeStyles('stalled')).toContainEqual(workStatusSurfaceStyle('attention'));
        expect(nodeStyles('asks')).toContainEqual(workStatusSurfaceStyle('attention'));
        expect(nodeStyles('broke')).toContainEqual(workStatusSurfaceStyle('danger'));
        const busy = nodeStyles('busy');
        expect(busy).not.toContainEqual(workStatusSurfaceStyle('attention'));
        expect(busy).not.toContainEqual(workStatusSurfaceStyle('danger'));
        // The lead carries no state of its own (S-6).
        expect(nodeStyles('lead')).not.toContainEqual(workStatusSurfaceStyle('attention'));
    }, 180_000);

    it('draws one line per sidebar node and the facts only where the map has room, and the lead says what it waits on', async () => {
        const { SessionWorkMapView } = await import('./SessionWorkMapView');
        const { projectSessionWorkMap } = await import('./workMapProducer');
        const busy = { ...report('busy', { state: 'thinking', bucket: 'working', tone: 'neutral', attentionType: null, word: 'Working' }), facts: ['asks a question'] };
        const projection: WorkProjection = {
            sessions: [busy], workflows: [], backgroundRuns: [], agents: [], projectCommands: [], archivedSessions: [],
            summary: { outstanding: 1, needsYou: 0, stalled: 0, sessions: 1, runs: 0 },
        };
        const map = projectSessionWorkMap({ managerSessionId: 'lead', leadTitle: 'Lead', projection });
        const sidebar = await renderScreen(
            <SessionWorkMapView map={map} projection={projection} showFacts={false} testIDPrefix="work-map" onOpenItem={vi.fn()} />,
        );
        expect(sidebar.getTextContent()).not.toContain('asks a question');
        // The lead's state slot: what it waits on, untinted (S-6).
        expect(sidebar.getTextContent()).toContain('sessionWork.map.waitingOn');
        await sidebar.unmount();
        const details = await renderScreen(
            <SessionWorkMapView map={map} projection={projection} showFacts testIDPrefix="work-map" onOpenItem={vi.fn()} />,
        );
        expect(details.getTextContent()).toContain('asks a question');
        await details.unmount();
        const idle = projectSessionWorkMap({ managerSessionId: 'lead', leadTitle: 'Lead',
            projection: { ...projection, summary: { ...projection.summary, outstanding: 0 } } });
        expect(idle.nodes.find((node) => node.kind === 'lead')?.status).toBeNull();
    }, 180_000);
});
