import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useAnnouncedCheckoutMachine, useCheckoutReachability } from '@/components/workspaces/reachability/checkoutReachability';
import { MANAGED_POWER_REQUIRED, ManagedWorkspaceStoppedState } from '@/components/workspaces/reachability/ManagedWorkspaceStoppedState';
import { useManagedMachineName } from '@/components/approvals/approvalReferenceReading';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';

/**
 * The shape both git surfaces store for a failed snapshot refresh. Only the presence of the error
 * and its structured code matter here: the raw `message` is transport vocabulary and never reaches
 * this card (`SourceControlUnavailableState` owns the one place a sanitized detail is shown).
 */
export type SourceControlStaleSnapshotError = Readonly<{
    errorCode?: string | null;
}>;

const stylesheet = StyleSheet.create(() => ({
    hiddenDiagnostic: {
        width: 0,
        height: 0,
    },
}));

/**
 * A source-control surface whose content is real but whose latest refresh failed.
 *
 * `F-SCM-2`: both git surfaces reported a snapshot error ONLY while they had nothing to show
 * (`!snapshot && error`). Neither store clears the snapshot when a refresh fails, so after the
 * first successful read the failure became invisible and stale content — including a stale
 * "not under source control" — read as current.
 *
 * The treatment is the shared freshness line (`SurfaceFreshnessLine`): keep the last good content and
 * say it is behind, with a retry, because hiding either half is worse than showing both. It
 * deliberately does NOT replace content —
 * {@link SourceControlUnavailableState} still owns the terminal state where there is nothing to
 * keep. Renders nothing when there is no error, so callers can mount it unconditionally.
 */
export function SourceControlStaleSnapshotNotice(props: Readonly<{
    error?: SourceControlStaleSnapshotError | null;
    onRetry?: () => void;
    /**
     * Scopes this notice's markers, including `${testID}-action`. Both git surfaces can be mounted
     * at once, so each passes its own — an unscoped id lets a hidden twin answer for the visible
     * one (the ambiguity L1 removed from the unavailable card).
     */
    testID: string;
    /** The checkout this snapshot reads: a stopped attached workspace says so over the kept changes, with Start. */
    workspaceScope?: WorkspaceScopeBase | null;
}>): React.ReactElement | null {
    // Under a page that announces its checkout machine, an unreachable machine is already said once with
    // its Retry ("As of 10:42 · devbox isn't answering"); the refresh that failed because of it is the
    // same cause, so the surface inherits that line instead of adding a second one.
    const causeAnnounced = useCheckoutReachability(useAnnouncedCheckoutMachine()).announced;
    if (!props.error || causeAnnounced) return null;

    const errorCode = typeof props.error.errorCode === 'string' && props.error.errorCode.length > 0
        ? props.error.errorCode
        : null;
    // A stopped workspace is not a refresh that fell behind: one line names it and offers Start (lab project-stopped).
    if (errorCode === MANAGED_POWER_REQUIRED) {
        // Recovery after Start is the SCM owner's settled republish (07ec0b22fd4), not a per-pane refresh.
        return <StoppedWorkspaceLine testID={`${props.testID}-stopped`} workspaceScope={props.workspaceScope ?? null} />;
    }

    // Pane-states lab 0 "Stale": the retained content stays at full strength under ONE freshness line
    // that says it is behind and offers the retry — the shared line, not a SCM-local banner.
    return (
        <>
            <SurfaceFreshnessLine
                testID={props.testID}
                tone="warning"
                reason={t('files.sourceControlStale.body')}
                {...(props.onRetry ? { action: { label: t('common.retry'), onPress: props.onRetry } } : {})}
            />
            {errorCode ? (
                // Diagnostics-only channel, matching `SurfaceStateCard`: the raw code is reachable
                // for QA through a testID and never rendered or announced.
                <View
                    testID={`${props.testID}-diagnostic-${errorCode}`}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={stylesheet.hiddenDiagnostic}
                />
            ) : null}
        </>
    );
}

function StoppedWorkspaceLine(props: Readonly<{ testID: string; workspaceScope: WorkspaceScopeBase | null }>) {
    const workspace = props.workspaceScope?.workspace;
    const workspaceName = useManagedMachineName(workspace ? props.workspaceScope!.serverId : null, workspace?.managedId ?? null);
    return <ManagedWorkspaceStoppedState testID={props.testID} size="line" workspaceName={workspaceName}
        reason={t('files.pane.managedStoppedChangesReason')} workspaceScope={props.workspaceScope} />;
}
