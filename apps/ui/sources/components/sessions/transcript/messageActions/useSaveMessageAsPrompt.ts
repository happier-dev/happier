import * as React from 'react';
import { Modal } from '@/modal';
import { t } from '@/text';
import { listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { PromptInvocationEntryV1Schema, validatePromptInvocationTokenV1 } from '@happier-dev/protocol/prompts/library/promptInvocationsV1';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { storage, useSettingMutable } from '@/sync/domains/state/storage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { randomUUID } from '@/platform/randomUUID';

export type SaveMessageAsPromptSaved = Readonly<{ artifactId: string; title: string; favorite: boolean }>;

/**
 * The one save owner for "a message becomes a prompt": the name (its first line), the favourite
 * (on by default, lab R1s), an optional `/` shortcut, one in-flight admission, and `prompt_doc.create`
 * on the Account the form opened under. The message-row popover, the phone sheet and the prompt
 * picker's in-place row all save through it.
 */
export function useSaveMessageAsPrompt(props: Readonly<{
    text: string;
    serverId?: string | null;
    onSaved: (saved: SaveMessageAsPromptSaved) => void;
}>) {
    const [title, setTitle] = React.useState(() => props.text.split(/\r?\n/, 1)[0].trim());
    const [favorite, setFavorite] = React.useState(true);
    const [shortcutExpanded, setShortcutExpanded] = React.useState(false);
    const [shortcut, setShortcut] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const saving = React.useRef(false);
    const [isSaving, setIsSaving] = React.useState(false);
    const [, setInvocations] = useSettingMutable('promptInvocationsV1');
    const [lifetime] = React.useState(captureActiveServerAccountScopeLifetime);
    const [controller] = React.useState(() => new AbortController());
    React.useEffect(() => {
        const retirement = lifetime?.onRetire(() => controller.abort());
        return () => { retirement?.dispose(); controller.abort(); };
    }, [controller, lifetime]);
    const save = async () => {
        if (saving.current || !title.trim()) return;
        if (!lifetime?.isCurrent() || controller.signal.aborted
            || !areAccountSettingsScopesEqual(storage.getState().settingsScope, lifetime.scope)
            || (props.serverId && !areServerProfileIdentifiersEquivalent(props.serverId, lifetime.scope.serverId))) {
            setError(t('committedMessageActions.wrongAccount'));
            return;
        }
        const actionTokens = listActionSpecs().filter((spec) => spec.surfaces.ui === true).flatMap((spec) => spec.slash?.tokens ?? []);
        const validation = shortcut.trim() ? validatePromptInvocationTokenV1({ token: shortcut,
            entries: storage.getState().settings.promptInvocationsV1.entries, actionTokens }) : null;
        if (validation && !validation.ok) {
            setError(validation.reason === 'reserved' ? t('promptLibrary.templateTokenReserved')
                : validation.reason === 'actionCollision' ? t('promptLibrary.templateTokenConflictsWithAction')
                : validation.reason === 'duplicate' ? t('promptLibrary.templateTokenDuplicate') : t('promptLibrary.saveError'));
            return;
        }
        setError(null);
        saving.current = true;
        setIsSaving(true);
        try {
            const result = await createDefaultActionExecutor().execute('prompt_doc.create',
                { title: title.trim(), markdown: props.text, favorite },
                { surface: 'ui', serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId, signal: controller.signal });
            if (!lifetime.isCurrent() || controller.signal.aborted) return;
            if (!result.ok || !result.result || typeof result.result !== 'object'
                || !('artifactId' in result.result) || typeof result.result.artifactId !== 'string') {
                setError(t('promptLibrary.saveError'));
                return;
            }
            const artifactId = result.result.artifactId;
            if (validation?.ok) {
                // Read the current projection after the Artifact round-trip, not the form's
                // opening snapshot, so a concurrent shortcut is never overwritten.
                try {
                    const current = storage.getState().settings.promptInvocationsV1;
                    const latest = validatePromptInvocationTokenV1({ token: validation.token, entries: current.entries, actionTokens });
                    if (!latest.ok) throw new Error('shortcut_unavailable');
                    const entry = PromptInvocationEntryV1Schema.parse({ id: randomUUID(), token: latest.token,
                        title: title.trim(), target: { kind: 'doc', artifactId },
                        behavior: 'insert', allowArgs: false, availableIn: 'global' });
                    setInvocations({ ...current, entries: [...current.entries, entry] });
                } catch {
                    // Creation already succeeded. Do not offer a retry that creates a second doc.
                    Modal.alert(t('committedMessageActions.savedOpen'), t('committedMessageActions.shortcutNotSaved'));
                }
            }
            props.onSaved({ artifactId, title: title.trim(), favorite });
        } catch {
            if (!controller.signal.aborted) setError(t('promptLibrary.saveError'));
        } finally {
            saving.current = false;
            if (!controller.signal.aborted) setIsSaving(false);
        }
    };
    const canSave = title.trim().length > 0 && !isSaving;
    return { title, setTitle, favorite, setFavorite, shortcutExpanded, setShortcutExpanded, shortcut, setShortcut,
        error, setError, isSaving, canSave, save };
}
