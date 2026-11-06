import * as React from 'react';
import { BotTemplateActionOutputSchemasV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { readUiBotTemplateAuthorDraft } from '@/sync/ops/actions/botTemplateActionDeps';
import { createBotTemplateEditorBuffer, type BotTemplateEditorBuffer, type BotTemplateEditorSnapshot, type BotTemplateSave } from './botTemplateEditorBuffer';
import { subscribeBotTemplateArtifactChanges } from './botTemplateArtifactChanges';
import { readServerAccountScopeOwnerLifetime } from '@/sync/domains/scope/serverAccountScope';

const buffers = new Map<string, Promise<BotTemplateEditorBuffer>>();

export function useBotTemplateEditor(artifactId: string, serverId: string) {
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const execution = useMountedActionExecution(binding?.scope ?? null);
    const [attempt, retry] = React.useReducer(value => value + 1, 0);
    const key = binding ? JSON.stringify([binding.scope.serverId, binding.scope.accountId, artifactId]) : null;
    const [read, setRead] = React.useState<Readonly<{ key: string; buffer: BotTemplateEditorBuffer | null; failed: boolean; errorCode?: string }> | null>(null);
    React.useEffect(() => binding && execution.ready
        ? subscribeBotTemplateArtifactChanges(binding, retry, artifactId) : undefined, [binding, execution.ready, artifactId]);
    React.useEffect(() => {
        if (!key || !binding || !execution.ready) return;
        let mounted = true;
        let pending = buffers.get(key);
        const retained = Boolean(pending);
        if (!pending) {
            pending = (async () => {
                const opening = await readUiBotTemplateAuthorDraft({ serverId, artifactId, expectedAccountId: binding.scope.accountId });
                return createBotTemplateEditorBuffer(opening);
            })();
            buffers.set(key, pending);
            readServerAccountScopeOwnerLifetime(binding).onRetire(() => { if (buffers.get(key) === pending) buffers.delete(key); });
            void pending.catch(() => { if (buffers.get(key) === pending) buffers.delete(key); });
        }
        void pending.then(async buffer => {
            if (retained && buffer.getSnapshot().status === 'saved') {
                const opening = await readUiBotTemplateAuthorDraft({ serverId, artifactId, expectedAccountId: binding.scope.accountId });
                if (mounted && binding.isCurrent()) buffer.reconcile(opening);
            }
            if (mounted && binding.isCurrent()) setRead({ key, buffer, failed: false });
        }).catch(error => {
            const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
            if (mounted) setRead({ key, buffer: null, failed: true, errorCode: typeof code === 'string' ? code : undefined });
        });
        return () => { mounted = false; };
    }, [key, binding, execution.ready, artifactId, serverId, attempt]);
    const save = React.useCallback<BotTemplateSave>(async ({ draft, revision }) => {
        const result = await execution.execute('template.draft', { sourceSessionRef: draft.sourceSessionRef, draftArtifactId: artifactId,
            expectedRevision: revision, content: draft.content, candidates: draft.candidates });
        if (!result.ok) return { ok: false, code: result.errorCode ?? result.error };
        const saved = BotTemplateActionOutputSchemasV1['template.draft'].safeParse(result.result);
        return saved.success ? { ok: true, revision: saved.data.revision } : { ok: false, code: 'invalid_action_output' };
    }, [artifactId, execution.execute]);
    return { buffer: read?.key === key ? read.buffer : null, failed: read?.key === key && read.failed,
        errorCode: read?.key === key ? read.errorCode : undefined, retry, save, execute: execution.execute, scope: binding?.scope ?? null };
}

/** Each field subscribes only to its own stable value; typing does not rerender the editor page. */
export function useBotTemplateEditorValue<T>(buffer: BotTemplateEditorBuffer, select: (state: BotTemplateEditorSnapshot) => T): T {
    const read = React.useCallback(() => select(buffer.getSnapshot()), [buffer, select]);
    return React.useSyncExternalStore(buffer.subscribe, read, read);
}
