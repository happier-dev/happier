import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createInteractiveExecutionRunDraftDetailsTab } from '@/components/sessions/runs/launcher/executionRunLauncherModel';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { appendMountedComposerDraft } from '@/sync/ops/actions/appendMountedComposerDraft';
import { createUiExecutionRunActionDeps } from '@/sync/ops/actions/executionRunActionDeps';
import { loadAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { settingsParse } from '@/sync/domains/settings/settings';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveAskSelectionDestination, type FilesAskWithoutSessionTarget } from './askSelectionModel';

export type AskSelectionSessionTarget = Readonly<{ sessionId: string; revealSessionColumn?: () => void }>;

/** Pane-owned effects consumed unchanged by selection toolbars and Problems. */
export type AskSelectionTargetContext = Readonly<{
    accountLifetime?: ServerAccountScopeLifetime | null;
    withoutSessionTarget?: FilesAskWithoutSessionTarget;
    openDetailsTab: AppPaneScopeApi['openDetailsTab'];
    navigateToNewSession: Parameters<typeof seedAndOpenNewSession>[0]['navigateToNewSession'];
    onDetachedUnavailable?: (reason: string) => void;
}>;

/** The one destination decision for every fenced selection quote. Never sends a question. */
export async function askSelectionQuote(input: Readonly<{
    workspaceScope: WorkspaceScopeBase;
    sessionTarget: AskSelectionSessionTarget | null;
    quote: string;
    context: AskSelectionTargetContext;
    sideRun?: boolean;
}>): Promise<boolean> {
    const { context, workspaceScope, sessionTarget } = input;
    const lifetime = context.accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : context.accountLifetime;
    if (!lifetime?.isCurrent() || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, workspaceScope.serverId)) return false;
    if (sessionTarget && !input.sideRun) {
        const applied = await appendMountedComposerDraft({ scope: lifetime.scope,
            ref: { kind: 'session', sessionId: sessionTarget.sessionId }, text: input.quote });
        if (applied && lifetime.isCurrent()) sessionTarget.revealSessionColumn?.();
        return applied;
    }
    const target = context.withoutSessionTarget ?? settingsParse(loadAccountSettings(lifetime.scope).settings).filesAskWithoutSessionTarget;
    let detachedSupported = true;
    if (!sessionTarget && (input.sideRun || target === 'detached_run')) {
        const support = await createUiExecutionRunActionDeps(lifetime.scope).executionRunCheckProtocolV2?.(null,
            { detachedScope: true, startAndWait: false, exactInputResults: true,
                runScopedAgentBindings: false, secretReferenceOverlay: false },
            { serverId: workspaceScope.serverId, targetMachineId: workspaceScope.machineId });
        if (!lifetime.isCurrent()) return false;
        detachedSupported = support?.ok === true || support?.errorCode !== 'execution_run_protocol_unsupported';
        if (support?.ok === false) context.onDetachedUnavailable?.(support.error);
    }
    const destination = resolveAskSelectionDestination({ sessionId: sessionTarget?.sessionId,
        target, detachedSupported, sideRun: input.sideRun });
    if (destination === 'side_run') {
        context.openDetailsTab(createInteractiveExecutionRunDraftDetailsTab({ initialText: input.quote,
            ...(!sessionTarget ? { detachedWorkspace: { machineId: workspaceScope.machineId, cwd: workspaceScope.rootPath } } : {}) }), { intent: 'pinned', start: true });
        return true;
    }
    const result = seedAndOpenNewSession({ seed: { prompt: input.quote,
        placement: { kind: 'exactTarget', serverId: workspaceScope.serverId,
            machineId: workspaceScope.machineId, directory: workspaceScope.rootPath } },
        scope: lifetime.scope, isCurrent: lifetime.isCurrent, navigateToNewSession: context.navigateToNewSession });
    return result.kind === 'opened';
}
