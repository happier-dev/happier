import * as React from 'react';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { ScmWorkingEntry, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { LocalServiceInventoryRow } from '@/sync/domains/local/services/inventory/store';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import { buildSessionScmSummary } from '@/components/sessions/sourceControl/status/statusSummary';
import { buildLocalServiceRows, selectLocalServiceRunningCount } from '@/sync/domains/local/services/serviceRow';

import { ChangesGlanceView } from './ChangesGlance';
import { resolveLocalServicesGlanceRows } from './glanceModels';
import { LocalServicesGlance, LocalServicesGlanceView } from './LocalServicesGlance';
import { PaneLinkRowView } from './PaneLinkRow';
import { SessionAgentPlanCard } from '../plan/SessionAgentPlanCard';
import { projectSessionAgentPlan } from '../plan/sessionAgentPlan';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

// These glance contracts never access the Session-envelope HTTP API.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Session-envelope HTTP API is outside this glance test'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});

// No Markdown is rendered here; preserve the external SDK boundary if reached.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Markdown SDK is outside this glance test'); },
}));

afterEach(() => {
    standardCleanup();
});

describe('Sized agent plan', () => {
    it('leads a compact body with the current step and restores source order in a tall body without dropping steps', async () => {
        const plan = projectSessionAgentPlan([
            { id: 'done', content: 'Prepared', status: 'completed', priority: 'medium' },
            { id: 'now', content: 'Verifying', status: 'in_progress', priority: 'medium' },
            { id: 'next', content: 'Handing off', status: 'pending', priority: 'medium' },
        ]);
        const render = (size: 'small' | 'tall') => <WidgetPresentationProvider value={{ size,
            footprint: { columns: 2, columnSpan: 1, rowSpan: size === 'small' ? 1 : 4,
                width: 'half', height: size === 'small' ? 'compact' : 'tall' } }}>
            <SessionAgentPlanCard plan={plan} agentLabel="Codex" activity="working" presentation="body" testID="sized-plan" />
        </WidgetPresentationProvider>;
        const screen = await renderScreen(render('small'));
        expect(screen.getTextContent().indexOf('Verifying')).toBeLessThan(screen.getTextContent().indexOf('Prepared'));
        expect(screen.getTextContent()).toContain('Handing off');
        await screen.update(render('tall'));
        expect(screen.getTextContent().indexOf('Prepared')).toBeLessThan(screen.getTextContent().indexOf('Verifying'));
    });
});

function entry(path: string, kind: ScmWorkingEntry['kind'], added: number, removed: number): ScmWorkingEntry {
    return {
        path,
        previousPath: null,
        kind,
        includeStatus: ' ',
        pendingStatus: 'M',
        hasIncludedDelta: false,
        hasPendingDelta: true,
        stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: added, pendingRemoved: removed, isBinary: false },
    };
}

function snapshot(overrides: Partial<ScmWorkingSnapshot> = {}): ScmWorkingSnapshot {
    const entries = [
        entry('relay/client.ts', 'modified', 42, 6),
        entry('relay/backoff.ts', 'untracked', 88, 0),
        entry('relay/client.test.ts', 'modified', 118, 3),
        entry('docs/relay.md', 'modified', 12, 2),
        entry('README.md', 'modified', 1, 1),
    ];
    return {
        projectKey: 'machine:/repo',
        fetchedAt: 1_700_000_000_000,
        repo: { isRepo: true, rootPath: '/repo' },
        branch: { head: 'relay-retry', upstream: null, ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries,
        totals: { includedFiles: 0, pendingFiles: 5, untrackedFiles: 1, includedAdded: 0, includedRemoved: 0, pendingAdded: 261, pendingRemoved: 12 },
        ...overrides,
    };
}

function launchTarget(overrides: Partial<LocalServiceLaunchTarget>): LocalServiceLaunchTarget {
    return {
        id: 'inventory:web',
        source: 'inventory_entry',
        machineId: 'machine-a',
        sessionId: 'session-a',
        title: 'web',
        subtitle: 'localhost:8081',
        confidence: 'high',
        state: 'available',
        actions: ['open'],
        browserTarget: {
            kind: 'externalUrl',
            targetId: 'inventory-loopback:web',
            url: 'http://127.0.0.1:8081/',
            display: { title: 'web', addressLabel: 'localhost:8081' },
        },
        ...overrides,
    } as LocalServiceLaunchTarget;
}

function inventoryRow(id: string, port: number): LocalServiceInventoryRow {
    return {
        id,
        machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        port,
        protocol: 'tcp',
        state: 'listening',
        source: 'detected',
        confidence: 'high',
        provenance: { process: { pid: 400, lineagePids: [400], command: 'vite', cwd: '/repo', redacted: true }, workspace: { path: '/repo', association: 'process_tree' } },
        presentation: { addressLabel: `localhost:${port}`, displayName: id },
    } as LocalServiceInventoryRow;
}

describe('Sized local services', () => {
    it('compacts status into a spoken service row and restores richer status lines without losing facts or Open', async () => {
        const open = vi.fn();
        const target = launchTarget({});
        const state = { kind: 'ready' as const, runningCount: 1, rows: [
            { id: 'web', title: 'web', detail: 'localhost:8081', running: true, openTarget: target },
            { id: 'docs', title: 'docs', detail: 'storybook', running: false, openTarget: null },
        ] };
        const render = (size: 'small' | 'tall') => <WidgetPresentationProvider value={{ size,
            footprint: { columns: 2, columnSpan: 1, rowSpan: size === 'small' ? 1 : 4, width: 'half', height: size === 'small' ? 'compact' : 'tall' } }}>
            <LocalServicesGlanceView testID="sized-services" frameStyle="plain" presentation="body" machineName="Mac" state={state} onOpen={open} />
        </WidgetPresentationProvider>;
        const screen = await renderScreen(render('small'));
        expect(screen.findByTestId('sized-services.row.web')?.props.accessibilityLabel).toBe('web, localhost:8081, widgetGlances.running');
        expect(screen.findByTestId('sized-services.row.web.status')).toBeNull();
        const openControl = screen.findByTestId('sized-services.row.web.open');
        await screen.update(render('tall'));
        expect(screen.findByTestId('sized-services.row.web.status')).not.toBeNull();
        expect(screen.findByTestId('sized-services.row.web.open')).toBe(openControl);
        expect(screen.getTextContent()).toContain('localhost:8081');
        expect(screen.getTextContent()).toContain('storybook');
        expect(screen.getTextContent()).toContain('widgetGlances.notRunning');
        await screen.pressByTestIdAsync('sized-services.row.web.open');
        expect(open).toHaveBeenCalledWith(target);
    });
});

describe('Changes glance', () => {
    it('recomposes compact and tall sizes without losing the real changed total or review action', async () => {
        const summary = buildSessionScmSummary(snapshot())!;
        const review = vi.fn();
        const render = (size: 'small' | 'tall', rowSpan: number) => <WidgetPresentationProvider value={{ size,
            footprint: { columns: 2, columnSpan: 1, rowSpan, height: size === 'small' ? 'compact' : 'tall', width: 'half' } }}>
            <ChangesGlanceView testID="sized-changes" frameStyle="plain" state={{ kind: 'ready', summary }} onReviewChanges={review} />
        </WidgetPresentationProvider>;
        const screen = await renderScreen(render('small', 1));
        expect(screen.findAll(node => node.props?.testID === 'sized-changes.file')).toHaveLength(1);
        expect(screen.getTextContent()).toContain('widgetGlances.moreFiles');
        await screen.update(render('tall', 4));
        expect(screen.findAll(node => node.props?.testID === 'sized-changes.file')).toHaveLength(5);
        await screen.pressByTestIdAsync('sized-changes.open');
        expect(review).toHaveBeenCalledOnce();
    });
    it('offers walkthrough beside review without replacing the review footer', async () => {
        const review = vi.fn();
        const walk = vi.fn();
        const screen = await renderScreen(
            <ChangesGlanceView testID="changes" frameStyle="plain" state={{ kind: 'ready', summary: buildSessionScmSummary(snapshot())! }}
                onReviewChanges={review} onWalkThrough={walk} />,
        );
        await screen.pressByTestIdAsync('changes.secondary-open');
        await screen.pressByTestIdAsync('changes.open');
        expect(walk).toHaveBeenCalledTimes(1);
        expect(review).toHaveBeenCalledTimes(1);
    });

    it('shows the branch, the real changed count and the first files, and says how many more there are', async () => {
        const review = vi.fn();
        const summary = buildSessionScmSummary(snapshot())!;
        const screen = await renderScreen(
            <ChangesGlanceView testID="changes" frameStyle="plain" state={{ kind: 'ready', summary }} onReviewChanges={review} />,
        );
        await flushHookEffects({ cycles: 2 });
        const text = screen.getTextContent();
        expect(text).toContain('relay-retry');
        expect(text).toContain('widgetGlances.changedCount');
        // The first three files in the summary owner's own order; the fourth is left to "N more".
        for (const file of summary.files.slice(0, 3)) expect(text).toContain(file.fileName);
        expect(text).not.toContain(summary.files[3]!.fileName);
        // Five changed, three drawn: the remainder is the real total minus the rows shown.
        expect(screen.findByTestId('changes.more')).toBeTruthy();
        expect(text).toContain('widgetGlances.moreFiles');
        screen.pressByTestId('changes.open');
        expect(review).toHaveBeenCalledTimes(1);
    });

    it('says quietly that the folder is not a Git repository, with nothing to review', async () => {
        const screen = await renderScreen(<ChangesGlanceView testID="changes" frameStyle="plain" state={{ kind: 'notRepo' }} onReviewChanges={vi.fn()} />);
        await flushHookEffects({ cycles: 2 });
        expect(screen.getTextContent()).toContain('widgetGlances.notARepo');
        expect(screen.findByTestId('changes.open')).toBeNull();
    });
});

describe('Local services glance', () => {
    it('counts the running services, offers Open on them, and lists a stopped script as Not running with no action', async () => {
        const rows = buildLocalServiceRows({
            inventoryRows: [inventoryRow('web', 8081), inventoryRow('relay', 3011)],
            launchTargets: [
                launchTarget({ id: 'inventory:web', sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'web' } } as Partial<LocalServiceLaunchTarget>),
                launchTarget({
                    id: 'inventory:relay',
                    title: 'relay',
                    sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'relay' },
                    browserTarget: { kind: 'externalUrl', targetId: 'inventory-loopback:relay', url: 'http://127.0.0.1:3011/', display: { title: 'relay', addressLabel: 'localhost:3011' } },
                } as Partial<LocalServiceLaunchTarget>),
                launchTarget({
                    id: 'package:storybook',
                    source: 'package_script',
                    title: 'storybook',
                    state: 'unavailable',
                    unavailableReason: 'package_script_start_unavailable',
                    actions: [],
                    browserTarget: undefined,
                    sourceClass: { kind: 'package_script', runTargetId: 'storybook', packageName: 'web', scriptName: 'storybook', cwd: '/repo' },
                } as Partial<LocalServiceLaunchTarget>),
            ],
            sessionId: 'session-a',
            scope: 'workspace',
        });
        const open = vi.fn();
        const screen = await renderScreen(
            <LocalServicesGlanceView
                testID="services"
                frameStyle="plain"
                machineName="MacBook Pro"
                state={{ kind: 'ready', rows: resolveLocalServicesGlanceRows(rows), runningCount: selectLocalServiceRunningCount(rows) }}
                onOpen={open}
            />,
        );
        await flushHookEffects({ cycles: 2 });
        const text = screen.getTextContent();
        expect(text).toContain('widgetGlances.runningCount');
        expect(text).toContain('storybook');
        expect(text).toContain('widgetGlances.notRunning');
        expect(screen.findByTestId('services.row.package:storybook.open')).toBeNull();
        screen.pressByTestId('services.row.inventory:web.open');
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('says nothing is running in one quiet line when the session runs no service', async () => {
        const screen = await renderScreen(
            <LocalServicesGlanceView testID="services" frameStyle="plain" machineName={null} state={{ kind: 'ready', rows: [], runningCount: 0 }} onOpen={vi.fn()} />,
        );
        await flushHookEffects({ cycles: 2 });
        expect(screen.getTextContent()).toContain('widgetGlances.nothingRunning');
    });

    it('starts no machine feed while the Companion only measures its cards', async () => {
        // A measuring pass has no store, no machine and no pane: the glance must not reach for any.
        const screen = await renderScreen(
            <LocalServicesGlance testID="services" sessionId="session-a" serverId="server-a" frameStyle="plain" measurementOnly />,
        );
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('services.live')).toBeNull();
        expect(screen.findByTestId('services')).toBeTruthy();
    });
});

describe('Pane link row', () => {
    it('opens its pane from the row', async () => {
        const open = vi.fn();
        const screen = await renderScreen(
            <PaneLinkRowView testID="pane" frameStyle="plain" label="Agents" icon="tree-structure" fact="1 running" onOpen={open} />,
        );
        await flushHookEffects({ cycles: 2 });
        expect(screen.getTextContent()).toContain('Agents');
        expect(screen.getTextContent()).toContain('1 running');
        screen.pressByTestId('pane.open');
        expect(open).toHaveBeenCalledTimes(1);
    });
});
