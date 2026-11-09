import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { TrackPresence } from '@/components/sessions/files/track/TrackPauseSignal';
import { ScmWorkingEntrySchema } from '@happier-dev/protocol/scm/workingSnapshot';

installSessionFilesViewBoundaries({ platformOS: 'android' });
await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { createWorkspaceFileDetailsTab } = await import('@/components/appShell/panes/details/fileDetailsTab');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
const { CodeLinesViewCore } = await import('@/components/ui/code/view/CodeLinesViewCore');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { TrackPauseSignalProvider } = await import('@/components/sessions/files/track/TrackPauseSignal');

const filePath = 'src/useSettingsRouteKey.ts';
const tabKey = `file:${filePath}`;
const scopeId = 'session:agent-caret';
const text = Array.from({ length: 24 }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let pane: AppPaneScopeApi;

/** The Session pane's Track boundary hands its presence to the File pages it wraps (P5 §3.10). */
function TrackedFilePane(props: Readonly<{ presence: TrackPresence | null }>) {
    pane = useAppPaneScope(scopeId);
    React.useEffect(() => { pane.openDetailsTab(createWorkspaceFileDetailsTab(filePath), { intent: 'preview' }); }, []);
    return <KeyboardShortcutProvider handlers={{}}><PluginSurfaceFocusEligibilityProvider active>
        <TrackPauseSignalProvider signal={() => {}} presence={props.presence}>
            {pane.scopeState?.details.tabs.some(tab => tab.key === tabKey)
                ? <WorkspaceFileDetailsView scopeId={scopeId} scope={fixture.scope} filePath={filePath} sessionIdForAugmentation={null} />
                : null}
        </TrackPauseSignalProvider>
    </PluginSurfaceFocusEligibilityProvider></KeyboardShortcutProvider>;
}

/** The File page's read body receives the presence its rows draw (the rows are covered at the code view owner). */
function bodyPresence(screen: Awaited<ReturnType<typeof fixture.render>>) {
    return screen.findAllByType(CodeLinesViewCore)[0]?.props.agentPresence ?? null;
}

beforeEach(async () => {
    standardCleanup();
    const read = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-file-views.test',
        serverIdentityId: 'srv_agent_caret', accountId: 'alice', machineId: 'm1', tokenEpoch: 0,
        actionId: 'daemon.filesystem.readFile', execute: () => ({ success: true, content: Buffer.from(text).toString('base64') }) });
    fixture = await createSessionFilesViewFixture({ serverIdentityId: 'srv_agent_caret',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        request: async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: read.machine });
            return await read.handle(parsed, init) ?? new Response('{}', { status: 404 });
        },
        rpc: request => request.method === 'scm.diff.file'
            ? { success: true, diff: `--- a/${filePath}\n+++ b/${filePath}\n@@ -0,0 +1,24 @@\n${text.split('\n').map(line => `+${line}`).join('\n')}\n` }
            : ({ success: true, exists: true, kind: 'file', sizeBytes: Buffer.byteLength(text) }) });
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({ entries: [
        ScmWorkingEntrySchema.parse({ path: filePath, kind: 'untracked', includeStatus: ' ', pendingStatus: '?', hasPendingDelta: true }),
    ] }));
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

it('hands the read body the agent caret region in the file Track follows, and lets go when the agent moves on', async () => {
    const presence: TrackPresence = { path: filePath, region: { startLine: 14, endLine: 15 }, agentId: 'claude', agentName: 'Claude' };
    const screen = await fixture.render(<TrackedFilePane presence={presence} />);
    try {
        await vi.waitFor(() => expect(screen.findAllByType(CodeLinesViewCore)).toHaveLength(1));
        await vi.waitFor(() => expect(bodyPresence(screen)).toMatchObject({ startLine: 14, endLine: 15, agentId: 'claude', agentName: 'Claude' }));
        await screen.update(fixture.wrap(<TrackedFilePane presence={{ ...presence, path: 'src/other.ts' }} />));
        await vi.waitFor(() => expect(bodyPresence(screen)).toBeNull());
    } finally { await screen.unmount(); }
});

it('places the caret on the text an Edit replaces when the call names no lines', async () => {
    const presence: TrackPresence = { path: filePath, anchorText: 'const line9 = 9;\nconst line10 = 10;', agentId: 'claude', agentName: 'Claude' };
    const screen = await fixture.render(<TrackedFilePane presence={presence} />);
    try {
        await vi.waitFor(() => expect(bodyPresence(screen)).toMatchObject({ startLine: 9, endLine: 10 }));
    } finally { await screen.unmount(); }
});

it.each(['file', 'diff'] as const)('scrolls the %s body to the region Track asks for, resolved by the caret owner', async (mode) => {
  const { FileContentPanel } = await import('../file/FileContentPanel');
  const { act } = await import('@/dev/testkit');
  const { FilePageHeader } = await import('../file/FilePageHeader');
  const presence: TrackPresence = { path: filePath, anchorText: 'const line19 = 19;', agentId: 'claude', agentName: 'Claude', reveal: { seq: 1 } };
  const screen = await fixture.render(<TrackedFilePane presence={presence} />);
  try {
    if (mode === 'diff') await act(async () => { screen.findByType(FilePageHeader).props.onDisplayMode('diff'); });
    await vi.waitFor(() => expect(screen.findAllByType(FileContentPanel)[0]?.props.jumpToAnchor).toMatchObject({ kind: 'line', line: 19 }));
    const target = screen.findAllByType(CodeLinesViewCore)[0]?.props.scrollToLineId;
    expect(target).toBeDefined();
  } finally { await screen.unmount(); }
});
