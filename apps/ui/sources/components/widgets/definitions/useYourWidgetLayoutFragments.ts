import * as React from 'react';
import type { WidgetLayoutFragmentSummaryV1 } from '@happier-dev/protocol/widgets';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { runWidgetDefinitionCommand, type WidgetCommandTarget } from './widgetDefinitionCommands';

const EMPTY_FRAGMENTS: readonly WidgetLayoutFragmentSummaryV1[] = Object.freeze([]);

/** Mount only for an open group-capable Gallery; summaries never read executable child bodies. */
export function useYourWidgetLayoutFragments(account: WidgetCommandTarget | null): Readonly<{
    fragments: readonly WidgetLayoutFragmentSummaryV1[];
    actionsFor: (fragment: WidgetLayoutFragmentSummaryV1) => ItemAction[];
}> {
    const [inventory, setInventory] = React.useState<Readonly<{
        serverId: string; accountId: string; fragments: readonly WidgetLayoutFragmentSummaryV1[];
    }> | null>(null);
    const serverId = account?.serverId;
    const accountId = account?.accountId;
    const scope = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [accountId, serverId]);
    const [reload, refresh] = React.useReducer((value: number) => value + 1, 0);
    const request = React.useRef<Readonly<{ account: WidgetCommandTarget; controller: AbortController }> | null>(null);
    React.useEffect(() => {
        if (!scope) { setInventory(null); return; }
        const controller = new AbortController();
        const active = { account: scope, controller };
        request.current = active;
        void (async () => {
            const listed = await runWidgetDefinitionCommand('widgets.fragment.list', { account: scope }, scope, controller.signal);
            if (listed.kind === 'applied' && !controller.signal.aborted) setInventory({ ...scope, fragments: listed.result.fragments });
        })();
        return () => { controller.abort(); if (request.current === active) request.current = null; };
    }, [reload, scope]);
    const manage = React.useCallback(async (artifactId: string, intent: 'rename' | 'duplicate' | 'delete') => {
        const active = request.current;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!scope || active?.account !== scope || !lifetime?.isCurrent()
            || !areServerAccountScopesEqual(lifetime.scope, scope)) return;
        // Refreshing the list must not cancel another acknowledged management intent.
        const controller = new AbortController();
        const { signal } = controller;
        const cancellation = lifetime.onRetire(() => controller.abort());
        const current = () => !signal.aborted && lifetime.isCurrent() && request.current?.account === scope;
        const notify = (kind: 'approvalPending' | 'refused') => {
            if (!current()) return;
            Modal.alert(t(kind === 'approvalPending' ? 'common.info' : 'common.error'),
                t(kind === 'approvalPending' ? 'widgetAdd.areaApprovalPending' : 'errors.operationFailed'));
        };
        try {
            if (!current()) return;
            if (intent === 'duplicate') {
                // The Action owns the copy's name/default and its independent Artifact identity.
                const copied = await runWidgetDefinitionCommand('widgets.fragment.duplicate',
                    { account: scope, artifactId, newArtifactId: randomUUID() }, scope, signal);
                if (!current()) return;
                if (copied.kind === 'applied') refresh();
                else notify(copied.kind);
                return;
            }
            const opened = await runWidgetDefinitionCommand('widgets.fragment.get', { account: scope, artifactId }, scope, signal);
            if (!current()) return;
            if (opened.kind !== 'applied') { notify(opened.kind); return; }
            const name = opened.result.fragment.name;
            if (intent === 'rename') {
                const answer = await Modal.prompt(t('common.rename'), name, {
                    defaultValue: name, placeholder: t('widgetDefinition.name'), confirmText: t('common.save'), cancelText: t('common.cancel'),
                });
                const nextName = answer?.trim();
                if (!current() || !nextName || nextName === name) return;
                // This patch stays on the Fragment port; its Artifact CAS/retry owns revisions.
                const renamed = await runWidgetDefinitionCommand('widgets.fragment.update',
                    { account: scope, artifactId, patch: { name: nextName } }, scope, signal);
                if (!current()) return;
                if (renamed.kind === 'applied') refresh();
                else notify(renamed.kind);
            } else {
                const confirmed = await Modal.confirm(t('common.delete'), `${name}\n\n${t('widgetDefinition.deleteSavedGroupNote')}`, {
                    confirmText: t('common.delete'), cancelText: t('common.cancel'), destructive: true,
                });
                if (!current() || !confirmed) return;
                const deleted = await runWidgetDefinitionCommand('widgets.fragment.delete', { account: scope, artifactId }, scope, signal);
                if (!current()) return;
                if (deleted.kind === 'applied') refresh();
                else notify(deleted.kind);
            }
        } finally { cancellation.dispose(); }
    }, [scope]);
    const actionsFor = React.useCallback((fragment: WidgetLayoutFragmentSummaryV1): ItemAction[] => [
        { id: 'rename', title: t('common.rename'), icon: 'pencil-simple', onPress: () => { void manage(fragment.artifactId, 'rename'); } },
        { id: 'duplicate', title: t('common.duplicate'), icon: 'copy', onPress: () => { void manage(fragment.artifactId, 'duplicate'); } },
        { id: 'delete', title: t('common.delete'), icon: 'trash', destructive: true, onPress: () => { void manage(fragment.artifactId, 'delete'); } },
    ], [manage]);
    return { fragments: inventory && inventory.serverId === serverId && inventory.accountId === accountId ? inventory.fragments : EMPTY_FRAGMENTS, actionsFor };
}
