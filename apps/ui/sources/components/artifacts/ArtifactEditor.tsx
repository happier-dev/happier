import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { HAPPIER_FIELD_BOX_METRICS, HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { ArtifactHeaderMetadataV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { isArtifactHtmlHeaderV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';

import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Modal } from '@/modal';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { resolveActionExecutionErrorMessage, resolveActionExecutionFailureTitle } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import { runUnsavedChangesGuard, type ActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';

import { artifactViewRoute } from './artifactBrowserModel';
import { useArtifactActionsClient, type ArtifactQuota } from './artifactActionsClient';
import { ArtifactQuotaNotice } from './ArtifactQuotaNotice';
import { ArtifactView } from './ArtifactView';
import { presentArtifactActionFailure } from './artifactActionFailure';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';

/**
 * Writing a document: its title edited in the page header, its body below, one Save. A save the
 * server refuses for a budget keeps every edit and names the size and the cap (lab A8p).
 */
export function ArtifactEditor(props: Readonly<{ artifact: DecryptedArtifact | null; mode: 'new' | 'edit' }>): React.ReactElement {
    const router = useRouter();
    const navigation = useNavigation();
    const { artifact, mode } = props;
    const client = useArtifactActionsClient();
    const scope = useActiveServerAccountScope();
    // Draft fields, metadata and CAS belong to the same opening read, never a later socket head.
    const [opening] = React.useState(artifact);
    const [title, setTitle] = React.useState(artifact?.title ?? '');
    const [body, setBody] = React.useState(typeof artifact?.body === 'string' ? artifact.body : '');
    const bodyRef = React.useRef(body);
    bodyRef.current = body;
    const [saving, setSaving] = React.useState(false);
    const [quota, setQuota] = React.useState<ArtifactQuota | null>(null);
    const [conflict, setConflict] = React.useState(false);
    const editorRef = React.useRef<CodeEditorHandle | null>(null);
    const initialFocusRequested = React.useRef(false);
    // Engines boot after the page mounts. Ask once when the active surface can accept focus;
    // a mode switch must not take the cursor back from the title or another control.
    const focusNewDocument = React.useCallback(() => {
        if (mode !== 'new' || initialFocusRequested.current) return;
        initialFocusRequested.current = true;
        editorRef.current?.focus?.();
    }, [mode]);
    const draftChanged = React.useCallback((title: string, body: string) => mode === 'new'
        ? title.trim().length > 0 || body.trim().length > 0
        : title !== (opening?.title ?? '') || body !== (opening?.body ?? ''), [mode, opening]);
    const changed = draftChanged(title, body);
    const isDirtyRef = React.useRef(changed);
    isDirtyRef.current = changed;
    const ignoreRef = React.useRef(false);
    const prepareGuard = React.useCallback(async () => {
        await editorRef.current?.flushPendingChange();
        isDirtyRef.current = draftChanged(title, editorRef.current?.getValue() ?? bodyRef.current);
    }, [draftChanged, title]);

    const save = React.useCallback(async () => {
        if (saving) return false;
        setSaving(true);
        setQuota(null);
        try {
            // The editor may still hold a debounced keystroke: save only a confirmed value.
            await editorRef.current?.flushPendingChange();
            const body = editorRef.current?.getValue() ?? bodyRef.current;
            if (!draftChanged(title, body)) return false;
            if (!title.trim() && !body.trim()) {
                await Modal.alert(t('common.error'), t('artifacts.emptyFieldsError'));
                return false;
            }
            if (!client || (mode === 'edit' && (!opening?.isDecrypted || !opening.rawHeader || opening.bodyVersion === undefined))) {
                throw new Error('artifact_content_unavailable');
            }
            const header = ArtifactHeaderMetadataV1Schema.parse({ ...(mode === 'edit' ? opening?.rawHeader : {}), title: title.trim() || null });
            const outcome = mode === 'new'
                ? await client.createArtifact({ header, body: body.trim() })
                : await client.updateArtifact({ artifactId: opening!.id, header, body: body.trim(),
                    expectedRevision: { headerVersion: opening!.headerVersion, bodyVersion: opening!.bodyVersion! } });
            if ('approvalId' in outcome) {
                if (scope) router.pushRetainingCurrent(`/inbox/approvals/${encodeURIComponent(outcome.approvalId)}?serverId=${encodeURIComponent(scope.serverId)}` as never);
                return false;
            }
            if (!outcome.ok) {
                if (outcome.failure.quota) { setQuota(outcome.failure.quota); return false; }
                if (outcome.failure.code === 'version_mismatch') { setConflict(true); return false; }
                alertActionFailure(presentArtifactActionFailure(outcome.failure, mode === 'new' ? t('artifacts.createError') : t('artifacts.updateError')));
                return false;
            }
            ignoreRef.current = true;
            isDirtyRef.current = false;
            if (mode === 'new') router.replace(artifactViewRoute(outcome.value.artifactId) as never);
            else safeRouterBack({ router, fallbackHref: '/artifacts' });
            return true;
        } catch (failure) {
            await Modal.alert(resolveActionExecutionFailureTitle(failure, t('common.error')),
                resolveActionExecutionErrorMessage(failure, mode === 'new' ? t('artifacts.createError') : t('artifacts.updateError')));
            return false;
        } finally {
            setSaving(false);
        }
    }, [opening, draftChanged, client, mode, router, saving, scope, title]);

    const leave = React.useCallback(() => {
        safeRouterBack({ router, fallbackHref: '/artifacts' });
    }, [router]);
    const requestDecision = React.useCallback(() => promptUnsavedChangesAlert(
        (title, message, buttons) => Modal.alert(title, message, buttons), {
            title: t('common.discardChanges'), message: t('common.unsavedChangesWarning'),
            discardText: t('common.discard'), saveText: t('common.save'), keepEditingText: t('common.keepEditing'),
        }), []);
    const discard = React.useCallback(() => { ignoreRef.current = true; }, []);
    const guard = React.useMemo<ActiveUnsavedChangesGuard>(() => ({
        isDirtyRef, ignoreRef, prepareGuard, requestDecision, onDiscard: discard, onSave: save,
        continueOnSave: false, onHistoryLeave: leave, tag: 'ArtifactEditor.beforeRemove',
    }), [discard, leave, prepareGuard, requestDecision, save]);
    const continueNavigation = React.useCallback((action: unknown) => {
        const dispatch = (navigation as Readonly<{ dispatch?: (action: unknown) => void }>).dispatch;
        if (action && typeof dispatch === 'function') dispatch(action);
        else leave();
    }, [leave, navigation]);
    useUnsavedChangesBeforeRemoveGuard({ ...guard, ignoreRef, isDirty: changed, interceptWhenClean: true,
        enabled: mode !== 'edit' || typeof opening?.body !== 'object' || opening.body === null,
        onContinue: continueNavigation });
    const cancel = React.useCallback(async () => { await runUnsavedChangesGuard(guard, leave); }, [guard, leave]);

    // The source fills the window from its own top down (lab A8p) and scrolls inside, as an editor does.
    const [viewportHeight, setViewportHeight] = React.useState<number | null>(null);
    const [bodyTop, setBodyTop] = React.useState<number | null>(null);
    const measureViewport = React.useCallback((event: LayoutChangeEvent) => setViewportHeight(event.nativeEvent.layout.height), []);
    const measureBodyTop = React.useCallback((event: LayoutChangeEvent) => setBodyTop(event.nativeEvent.layout.y), []);
    const bodyHeight = viewportHeight === null || bodyTop === null ? MIN_BODY_HEIGHT_PX
        : Math.max(MIN_BODY_HEIGHT_PX, viewportHeight - bodyTop - HAPPIER_PAGE_METRICS.pagePaddingBottomPx);
    const bodyFrame = React.useMemo(() => ({ height: bodyHeight }), [bodyHeight]);

    // A direct edit URL must not reinterpret a binary body as an empty Markdown document.
    if (mode === 'edit' && opening?.body !== null && typeof opening?.body === 'object') {
        return <ArtifactView artifactId={opening.id} artifact={opening} presentation="page" />;
    }

    return (
        // The source sits in the column the Doc is read in, so editing never shifts the page sideways.
        <ItemList testID={`artifact-editor:${mode}`} onLayout={measureViewport} pageColumn="wide">
            <PageHeader
                testID="artifact-editor:header"
                title={title || t('artifacts.untitled')}
                alwaysShowTitle
                titleEditor={{
                    value: title,
                    placeholder: t('artifacts.untitled'),
                    accessibilityLabel: t('artifacts.titlePlaceholder'),
                    onChangeText: setTitle,
                    testID: 'artifact-editor:title',
                }}
                primaryAction={{ title: t('artifacts.save'), onPress: save, disabled: !changed, loading: saving, testID: 'artifact-editor:save' }}
                cancelAction={{ title: t('common.cancel'), onPress: cancel, testID: 'artifact-editor:cancel' }}
            />
            {/* A refusal is the page's one notice, in the document's column on the sections' edges (lab A8p). */}
            {conflict ? (
                <AttentionBanner testID="artifact-editor:conflict" tone="warning" announce="alert"
                    title={t('artifacts.browser.conflict.title')} description={t('artifacts.browser.conflict.body')} />
            ) : null}
            {quota ? <ArtifactQuotaNotice testID="artifact-editor:quota" quota={quota} /> : null}
            {/* The source is the page (lab A8p): on the canvas, unframed, filling the window below the header. */}
            <View onLayout={measureBodyTop}>
                <PageContentColumn style={BODY_INSET}>
                    <View style={bodyFrame}>
                        <MarkdownCodeEditorField
                            testID="artifact-editor:body"
                            resetKey={opening?.id ?? 'new'}
                            value={body}
                            placeholder={t('artifacts.bodyPlaceholder')}
                            accessibilityLabel={t('artifacts.bodyLabel')}
                            language={isArtifactHtmlHeaderV1(opening?.rawHeader ?? opening?.header) ? 'html' : 'markdown'}
                            onChange={setBody}
                            editorRef={editorRef}
                            onReady={focusNewDocument}
                            presentation="canvas"
                        />
                    </View>
                </PageContentColumn>
            </View>
        </ItemList>
    );
}

/** The source never draws shorter than a short note (sixteen field lines), even in a short window. */
const MIN_BODY_HEIGHT_PX = 16 * HAPPIER_FIELD_BOX_METRICS.lineHeightPx;
/** The document starts on its title's edge: the page text inset. */
const BODY_INSET = { paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx } as const;
