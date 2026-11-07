import * as React from 'react';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Modal } from '@/modal';
import { readUiBotTemplateAuthorDraft } from '@/sync/ops/actions/botTemplateActionDeps';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import { readSessionTemplateDraftRef, type SessionBotTemplateSource } from './openBotTemplate';

/** The Bot's existing menu addresses its private draft; Artifact admission owns deletion. */
export function useDeleteBotTemplate(session: SessionBotTemplateSource) {
    const ref = session.access?.role === 'owner' && readSessionBotV1(session.metadata?.bot)?.kind === 'bot'
        ? readSessionTemplateDraftRef(session) : null;
    return useDeleteBotTemplateDraft(ref);
}

/**
 * Deletes one owner-held template draft (the Bot menu and the template page's own ⋯ share it): confirm, read the
 * current revision, then `artifact.delete`. Null when there is nothing the owner may delete.
 */
export function useDeleteBotTemplateDraft(ref: Readonly<{ serverId: string; artifactId: string }> | null) {
    const actions = useMountedActionExecution(ref?.serverId ?? null);
    const router = useRouter();
    const serverId = ref?.serverId ?? null;
    const artifactId = ref?.artifactId ?? null;
    const remove = React.useCallback(async () => {
        if (!serverId || !artifactId || !actions.binding) return;
        const confirmed = await Modal.confirm(t('botTemplates.deleteTemplate'), t('botTemplates.deleteTemplateDescription'), {
            confirmText: t('common.delete'), destructive: true,
        });
        if (!confirmed || !actions.isCurrent()) return;
        try {
            const current = await readUiBotTemplateAuthorDraft({ serverId, artifactId, expectedAccountId: actions.binding.scope.accountId }, actions.getSignal());
            const result = await actions.execute('artifact.delete', { artifactId, expectedRevision: current.revision }, { confirmed: true });
            if (!actions.isCurrent()) return;
            if (!result.ok) throw result;
            router.replace('/artifacts');
        } catch (error) {
            if (actions.isCurrent()) Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(error, t('artifacts.deleteError')));
        }
    }, [serverId, artifactId, actions.binding, actions.execute, actions.getSignal, actions.isCurrent, router]);
    return serverId && artifactId ? remove : null;
}
