import * as React from 'react';
import { flushSync } from 'react-dom';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { WorkspaceShell } from '@/components/appShell/workspace/WorkspaceShell';
import { useOptionalWorkspaceNavigation } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { useWorkspaceFocusedDestinationTitle } from '@/components/appShell/workspace/WorkspaceWindowTitle';
import { DesktopShellWindowControlsHost } from '@/components/navigation/shell/desktopChrome/DesktopShellWindowControlsHost';
import { useResolvedDesktopWindowControls } from '@/components/navigation/shell/desktopChrome/useResolvedDesktopWindowControls';
import { APP_SHELL_TITLE_STRIP_HEIGHT_PX } from '@/components/navigation/shell/appRail/appRailMetrics';
import { useDesktopWindowDragMouseProps } from '@/components/navigation/desktopWindowChrome/DesktopWindowDragRegion';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { registerDesktopAppWindowActionResponder, registerDesktopAppWindowReturnHandler } from '@/sync/ops/actions/desktopAppWindowActionDispatch';
import { prepareSessionDraftWindowTransfer, resumeSessionDraftWindowPresentation } from '@/sync/ops/sessionDrafts/sessionDraftWindowTransfer';
import { flushSessionDraftLocally } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { prepareMountedTabPresentationTransfer, prepareMountedWindowPresentationTransfer } from '@/utils/navigation/runGuardedNavigation';
import { PaneTabDestination } from '@/components/appShell/panes/PaneTabDestinationHost';
import { serializeWorkspaceLayout, workspaceLayoutScopeKey } from '@/components/appShell/workspace/workspacePersistence';
import { workspaceLayoutsState } from '@/sync/domains/state/filePaneUiState';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import type { AppWindowRecord } from './appWindowBoot';
import { failDesktopAppWindow, readyDesktopAppWindow } from './appWindowRuntime';
import { useDesktopAppWindowRecord } from './AppWindowRecordContext';

/** The destination uses the ordinary retained body, with only its own window chrome. */
export function DesktopDestinationWindow(props: Readonly<{ full?: boolean; children?: React.ReactNode }> = {}) {
    const record = useDesktopAppWindowRecord();
    const workspace = useOptionalWorkspaceNavigation();
    const [prepared, setPrepared] = React.useState<AppWindowRecord | null>(null);
    const [released, setReleased] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    const draftRelease = React.useRef<(() => void) | null>(null);
    const paneOwner = React.useRef<Parameters<NonNullable<React.ComponentProps<typeof PaneTabDestination>['onReady']>>[0] | null>(null);
    const [paneReady, setPaneReady] = React.useState<AppWindowRecord | null>(null);
    const onPaneReady = React.useCallback<NonNullable<React.ComponentProps<typeof PaneTabDestination>['onReady']>>(owner => {
        paneOwner.current = owner;
        setPaneReady(record);
        return () => { if (paneOwner.current === owner) paneOwner.current = null; };
    }, [record]);
    const latest = React.useRef({ record, workspace });
    latest.current = { record, workspace };

    React.useEffect(() => {
        if (!record) return;
        let current = true;
        let stopActions: (() => void) | undefined;
        let stopReturn: (() => void) | undefined;
        setReleased(false);
        setFailed(false);
        void (async () => {
            const resumeDraft = async () => record.chrome !== 'full' && record.selectedAddress.kind === 'session'
                ? await resumeSessionDraftWindowPresentation({ sessionId: record.selectedAddress.sessionId,
                    serverId: record.homeId, accountId: record.accountId }) : () => {};
            const stopDraft = await resumeDraft();
            if (!current) { stopDraft(); return; }
            draftRelease.current = stopDraft;
            stopReturn = registerDesktopAppWindowReturnHandler(async intent => {
                const { record: currentRecord, workspace: currentWorkspace } = latest.current;
                const state = currentWorkspace?.state;
                const tabId = state?.groups[state.focusedGroupId].activeTabId;
                const target = tabId ? state?.tabs[tabId]?.target : undefined;
                if (currentRecord?.selectedAddress.kind === 'paneTab') {
                    if (!await (intent === 'close' ? paneOwner.current?.prepareClose() : paneOwner.current?.prepareTransfer())) return false;
                } else if (currentRecord?.chrome === 'full') {
                    if (!await prepareMountedWindowPresentationTransfer()) return false;
                    // The realm's local storage drains all retained Homes before any body releases.
                    await flushSessionDraftLocally({ scope: { serverId: currentRecord.homeId, accountId: currentRecord.accountId } });
                } else if (tabId && !await prepareMountedTabPresentationTransfer(tabId)) return false;
                if (currentRecord && currentRecord.chrome !== 'full' && currentRecord.selectedAddress.kind !== 'paneTab' && target?.kind === 'session' && target.params.id) {
                    await prepareSessionDraftWindowTransfer({ sessionId: target.params.id,
                        serverId: target.params.serverId ?? currentRecord.homeId,
                        accountId: target.params.accountId ?? currentRecord.accountId });
                }
                if (currentRecord && state) workspaceLayoutsState.set(workspaceLayoutScopeKey({
                    serverId: currentRecord.homeId, accountId: currentRecord.accountId, windowId: currentRecord.layoutId,
                }), serializeWorkspaceLayout(state));
                // The old composer must actually release before main can resume its writer.
                flushSync(() => setReleased(true));
                draftRelease.current?.(); draftRelease.current = null;
                return true;
            }, async () => {
                const stopDraft = await resumeDraft();
                if (!current) { stopDraft(); return; }
                draftRelease.current?.();
                draftRelease.current = stopDraft;
                flushSync(() => { setFailed(false); setPrepared(record); setReleased(false); });
            });
            stopActions = await registerDesktopAppWindowActionResponder();
            if (current) setPrepared(record);
            else { stopActions(); stopReturn(); }
        })().catch(() => {
            if (!current) return;
            setFailed(true);
            fireAndForget(failDesktopAppWindow(record, 'presentation_unavailable'), { tag: 'DesktopDestinationWindow.presentation' });
        });
        return () => { current = false; stopActions?.(); stopReturn?.(); draftRelease.current?.(); draftRelease.current = null; };
    }, [record]);

    React.useEffect(() => {
        if (prepared !== record || !record || (record.chrome !== 'full' && (!workspace?.active || !workspace.catalog))
            || (record.selectedAddress.kind === 'paneTab' && paneReady !== record)) return;
        fireAndForget(readyDesktopAppWindow(record), { tag: 'DesktopDestinationWindow.ready' });
    }, [prepared, record, workspace?.active, workspace?.catalog, paneReady]);

    if (props.full) return failed ? <SurfaceStateCard kind="unavailable" title={t('common.unavailable')} />
        : prepared !== record || released ? <PaneLoadingFallback /> : <>{props.children}</>;
    return <DestinationWindowChrome>
            {failed ? <SurfaceStateCard kind="unavailable" title={t('common.unavailable')} />
                : prepared !== record || released || !workspace?.active || !workspace.catalog ? <PaneLoadingFallback />
                    : record?.selectedAddress.kind === 'paneTab'
                        ? <PaneTabDestination address={{ ...record.selectedAddress, serverId: record.homeId, accountId: record.accountId }}
                            restoredTabKey={record.selectedAddress.resourceId} onReady={onPaneReady} />
                        : <WorkspaceShell catalog={workspace.catalog} presentation="destination" />}
    </DestinationWindowChrome>;
}

function DestinationWindowChrome(props: Readonly<{ children: React.ReactNode }>) {
    const title = useWorkspaceFocusedDestinationTitle();
    const controls = useResolvedDesktopWindowControls({ variant: 'expanded' });
    const drag = useDesktopWindowDragMouseProps();
    return <View style={styles.window}>
        <View {...drag} style={styles.titleBar}>
            <DesktopShellWindowControlsHost>{controls}</DesktopShellWindowControlsHost>
            <Text numberOfLines={1} style={styles.title}>{title ?? t('common.loading')}</Text>
        </View>
        <View style={styles.body}>{props.children}</View>
    </View>;
}

const styles = StyleSheet.create(theme => ({
    window: { flex: 1, minWidth: 0, minHeight: 0 },
    titleBar: { minHeight: APP_SHELL_TITLE_STRIP_HEIGHT_PX, flexDirection: 'row', alignItems: 'center', paddingRight: theme.space.s12 },
    title: { flex: 1, minWidth: 0, color: theme.colors.chrome.header.foreground },
    body: { flex: 1, minWidth: 0, minHeight: 0 },
}));
