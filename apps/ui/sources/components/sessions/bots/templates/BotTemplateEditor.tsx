import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { BotTemplateActionOutputSchemasV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { projectBotTemplateContentV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { BotTemplateHeader } from './BotTemplateHeader';
import { BotTemplatePreview } from './BotTemplatePreview';
import { showDocumentShareSheet } from '@/components/sharing/documents/showDocumentShareSheet';
import { BotTemplatePublishButton } from './BotTemplatePublishButton';
import { useBotTemplateEditor, useBotTemplateEditorValue } from './useBotTemplateEditor';
import type { BotTemplateEditorBuffer, BotTemplateSave } from './botTemplateEditorBuffer';
import { buildBotTemplateEditorRoute } from './botTemplateEditorDestination';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { InlineTextField } from '@/components/ui/text/InlineTextField';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { Typography } from '@/constants/Typography';
import { useShareViewerProfile } from '@/components/sharing/useShareViewerProfile';
import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';
import { readUiBotTemplateAuthorDraft } from '@/sync/ops/actions/botTemplateActionDeps';
import { BotTemplateMemorySection, BotTemplateSkillsSection } from './BotTemplateCandidateSections';
import { BotTemplateNeedsSection } from './BotTemplateNeedsSection';
import { BotTemplateAgentSection } from './BotTemplateAgentSection';

const styles = StyleSheet.create(theme => ({
    root: { flex: 1, minHeight: 0 },
    field: { ...Typography.variant('body'), color: theme.colors.text.primary },
    footer: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12, gap: theme.space.s8 },
    saveState: { flex: 1, minWidth: 0 },
    saveText: { color: theme.colors.text.secondary },
}));

export function BotTemplateEditor(props: Readonly<{ artifactId: string; serverId: string; presentation?: 'pane' | 'page' }>) {
    const editor = useBotTemplateEditor(props.artifactId, props.serverId);
    if (!editor.buffer || !editor.scope) return <SurfaceStateCard testID="bot-template-load" kind={editor.failed ? 'error' : 'loading'}
        title={editor.errorCode === 'update_required' ? t('connect.updateRequiredTitle')
            : editor.failed ? t('botTemplates.unavailable') : t('common.loading')}
        action={editor.failed ? { label: t('common.retry'), onPress: editor.retry } : undefined} />;
    return <BotTemplateEditorBody {...props} buffer={editor.buffer} scope={editor.scope} save={editor.save} execute={editor.execute} />;
}

export type BotTemplateEditorBodyProps = Readonly<{ artifactId: string; serverId: string; presentation?: 'pane' | 'page'; buffer: BotTemplateEditorBuffer;
    scope: ServerAccountScope; save: BotTemplateSave; execute: ReturnType<typeof useBotTemplateEditor>['execute'] }>;

type LoadedProps = BotTemplateEditorBodyProps;

/** The loaded editor; the dev specimen renders it with seed data. */
export function BotTemplateEditorBody(props: LoadedProps) {
    return <ReleaseControls {...props}>{(controls, action) => <View style={styles.root} testID="bot-template-editor">
            <EditorLeaveGuard buffer={props.buffer} save={props.save} />
            <ItemList keyboardAware>
                <EditorIdentity {...props} />
                <TemplateField buffer={props.buffer} save={props.save} field="instructions" />
                <BotTemplateMemorySection buffer={props.buffer} save={props.save} />
                <BotTemplateSkillsSection buffer={props.buffer} save={props.save} />
                <BotTemplateNeedsSection buffer={props.buffer} save={props.save} scope={props.scope} />
                <BotTemplateAgentSection buffer={props.buffer} save={props.save} />
                <TemplateField buffer={props.buffer} save={props.save} field="firstTask" />
                {props.presentation === 'page' ? <AuthorPreview buffer={props.buffer} /> : null}
                {controls}
            </ItemList>
            <KeyboardStickyFooter style={styles.footer}><View style={styles.saveState}><SaveState {...props} /></View><BotTemplatePublishButton {...props} />{action}</KeyboardStickyFooter>
        </View>}</ReleaseControls>;
}

function EditorLeaveGuard({ buffer, save }: Pick<LoadedProps, 'buffer' | 'save'>) {
    const status = useBotTemplateEditorValue(buffer, state => state.status);
    const navigation = useNavigation();
    const isDirty = status !== 'saved';
    const isDirtyRef = React.useRef(isDirty);
    isDirtyRef.current = isDirty;
    const requestDecision = React.useCallback(() => promptUnsavedChangesAlert(
        (title, message, buttons) => Modal.alert(title, message, buttons), {
            title: t('botTemplates.unsaved'), message: t('botTemplates.leavePrompt'),
            discardText: t('botTemplates.leaveKept'), saveText: t('common.save'), keepEditingText: t('common.keepEditing'),
        }), []);
    const onSave = React.useCallback(async () => {
        await buffer.commit(save);
        return buffer.getSnapshot().status === 'saved';
    }, [buffer, save]);
    const onContinue = React.useCallback((action: unknown) => {
        const dispatch = (navigation as Readonly<{ dispatch?: (action: unknown) => void }>).dispatch;
        if (action && dispatch) dispatch(action);
    }, [navigation]);
    useUnsavedChangesBeforeRemoveGuard({ isDirty, isDirtyRef, requestDecision, onSave, onContinue,
        tag: 'BotTemplateEditor.beforeRemove' });
    return null;
}

function AuthorPreview({ buffer }: Readonly<{ buffer: BotTemplateEditorBuffer }>) {
    const draft = useBotTemplateEditorValue(buffer, state => state.draft);
    const content = React.useMemo(() => projectBotTemplateContentV1(draft), [draft]);
    return <>
        <ItemGroup title={t('botTemplates.preview')}>{null}</ItemGroup>
        <BotTemplatePreview content={content} />
    </>;
}

function EditorIdentity(props: LoadedProps) {
    const identity = useBotTemplateEditorValue(props.buffer, state => state.draft.content.identity);
    const version = useBotTemplateEditorValue(props.buffer, state => state.releaseOptions.version);
    const profile = useShareViewerProfile(props.scope);
    const author = presentSharePrincipal({ ref: { kind: 'account', accountId: props.scope.accountId }, profile,
        viewerAccountId: props.scope.accountId }).displayName;
    const router = useRouter();
    const edit = (key: 'name' | 'description', value: string) => props.buffer.edit(draft => ({ ...draft,
        content: { ...draft.content, identity: { ...draft.content.identity, [key]: value } } }));
    return <BotTemplateHeader identity={identity} author={author} version={version} sharing={t('botTemplates.privateDraft')}
        titleEditor={{ value: identity.name, placeholder: t('common.name'), accessibilityLabel: t('common.name'),
            onChangeText: value => edit('name', value), onCommit: () => { void props.buffer.commit(props.save); }, testID: 'bot-template-name' }}
        descriptionEditor={{ value: identity.description, placeholder: t('botTemplates.description'), accessibilityLabel: t('botTemplates.description'),
            onChangeText: value => edit('description', value), onCommit: () => { void props.buffer.commit(props.save); }, testID: 'bot-template-description' }}
        prominence={props.presentation === 'page' ? 'hero' : 'page'}
        actions={props.presentation === 'pane' ? <IconButton testID="bot-template-expand" variant="plain" iconName="arrows-out"
            accessibilityLabel={t('common.expand')} tooltip={t('common.expand')} tooltipPlacement="bottom"
            onPress={() => router.pushRetainingCurrent(buildBotTemplateEditorRoute({ draftArtifactId: props.artifactId,
                sourceSessionRef: props.buffer.getSnapshot().draft.sourceSessionRef, presentation: 'page' }) as never)} /> : undefined} />;
}

function TemplateField(props: Readonly<{ buffer: BotTemplateEditorBuffer; save: BotTemplateSave; field: 'instructions' | 'firstTask' }>) {
    const value = useBotTemplateEditorValue(props.buffer, state => props.field === 'instructions'
        ? state.draft.content.instructions.markdown : state.draft.content.firstTask ?? '');
    const label = t(props.field === 'instructions' ? 'botTemplates.instructions' : 'botTemplates.firstTask');
    return <ItemGroup title={label} description={props.field === 'instructions' ? t('botTemplates.copiedInstructions') : undefined}><SectionContentRow><InlineTextField multiline style={styles.field} editor={{ value,
        placeholder: label, accessibilityLabel: label, testID: `bot-template-${props.field}`,
        onChangeText: text => props.buffer.edit(draft => ({ ...draft, content: { ...draft.content,
            ...(props.field === 'instructions' ? { instructions: { markdown: text } } : { firstTask: text }) } })),
        onCommit: () => { void props.buffer.commit(props.save); } }} /></SectionContentRow></ItemGroup>;
}

function SaveState(props: LoadedProps) {
    const status = useBotTemplateEditorValue(props.buffer, state => state.status);
    const [reviewing, setReviewing] = React.useState(false);
    const review = async () => {
        setReviewing(true);
        try {
            const { draft: other, revision } = await readUiBotTemplateAuthorDraft({ serverId: props.serverId,
                artifactId: props.artifactId, expectedAccountId: props.scope.accountId });
            const useBase = await Modal.confirm(t('botTemplates.reviewOther'),
                `${other.content.identity.name}\n\n${other.content.instructions.markdown}\n\n${other.content.firstTask ?? ''}`,
                { confirmText: t('botTemplates.useOtherBase') });
            if (useBase) props.buffer.useRevision(revision);
        } catch { await Modal.alert(t('common.error'), t('botTemplates.unavailable')); }
        finally { setReviewing(false); }
    };
    return <>
        {status === 'conflict' ? <AttentionBanner testID="bot-template-conflict" title={t('botTemplates.conflict')} tone="warning"
            action={{ label: t('botTemplates.reviewOther'), onPress: () => { void review(); }, loading: reviewing }} />
            : status === 'failed' ? <AttentionBanner testID="bot-template-save-failed" title={t('botTemplates.saveFailed')} tone="danger"
                action={{ label: t('common.retry'), onPress: () => { void props.buffer.commit(props.save); } }} />
                : <Text variant="meta" style={styles.saveText} numberOfLines={2} accessibilityLiveRegion="polite">{t(status === 'saving' ? 'botTemplates.saving'
                    : status === 'unsaved' ? 'botTemplates.unsaved' : 'botTemplates.savedAsYouEdit')}</Text>}
    </>;
}

function ReleaseControls(props: LoadedProps & Readonly<{ children: (controls: React.ReactNode, action: React.ReactNode) => React.ReactNode }>) {
    const options = useBotTemplateEditorValue(props.buffer, state => state.releaseOptions);
    const { version, changelog } = options;
    const setVersion = (value: string) => props.buffer.editRelease({ ...props.buffer.getSnapshot().releaseOptions, version: value });
    const setChangelog = (value: string) => props.buffer.editRelease({ ...props.buffer.getSnapshot().releaseOptions, changelog: value });
    const [releasing, setReleasing] = React.useState(false);
    const [shared, setShared] = React.useState(false);
    const release = () => {
        if (releasing || !version.trim()) return;
        const draft = props.buffer.getSnapshot().draft;
        showDocumentShareSheet({ artifactId: draft.releaseArtifactId, kind: 'bot_template.v1', scope: props.scope,
            name: draft.content.identity.name, reviewedSelection: { onSubmit: async selection => {
                setReleasing(true);
                const releaseOptions = props.buffer.getSnapshot().releaseOptions;
                try {
                    await props.buffer.commit(props.save);
                    const state = props.buffer.getSnapshot();
                    if (state.status !== 'saved') throw new Error('template_draft_not_saved');
                    let shareUrl: string | undefined;
                    const result = await props.execute('template.release', { draftArtifactId: props.artifactId,
                        expectedRevision: state.revision, version: releaseOptions.version, changelog: releaseOptions.changelog,
                        share: { recipients: [...selection.recipients], ...(selection.signedInLink ? { signedInLink: true } : {}) } },
                        { confirmed: true, executorOptions: { onPublicLinkIssued: issued => { shareUrl = issued.url; } } });
                    if (!result.ok || !BotTemplateActionOutputSchemasV1['template.release'].safeParse(result.result).success)
                        throw new Error('template_release_failed');
                    setShared(true);
                    return { ...(shareUrl ? { shareUrl } : {}) };
                } finally { setReleasing(false); }
            } } });
    };
    return props.children(<ItemGroup title={t('botTemplates.giveCopy')}>
        <Item title={t('botTemplates.version')} rightElement={<InlineTextField style={styles.field} editor={{ value: version,
            placeholder: '1.0.0', accessibilityLabel: t('botTemplates.version'), onChangeText: setVersion, testID: 'bot-template-version' }} />} />
        <Item title={t('botTemplates.notes')} accessoryLayout="stacked" rightElement={<InlineTextField multiline style={styles.field}
            editor={{ value: changelog, placeholder: t('botTemplates.notes'), accessibilityLabel: t('botTemplates.notes'), onChangeText: setChangelog }} />} />
        {shared ? <Item title={t('shareSheet.documents.title')} subtitle={t('botTemplates.shared')} onPress={() => {
            const draft = props.buffer.getSnapshot().draft;
            showDocumentShareSheet({ artifactId: draft.releaseArtifactId, kind: 'bot_template.v1', scope: props.scope,
                name: draft.content.identity.name });
        }} /> : null}
    </ItemGroup>, <RoundButton size="normal" title={t('botTemplates.shareEllipsis')} loading={releasing}
            disabled={!version.trim() || releasing} onPress={release} testID="bot-template-release" />
    );
}
