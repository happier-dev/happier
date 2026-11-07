import * as React from 'react';
import * as z from 'zod/mini';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { File } from 'expo-file-system';
import { encodeBase64, decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { useStore } from 'zustand';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { useCurrentUiContextLocalCommands, useCurrentUiContextMountedCommand, type CurrentUiContextLocalCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { CurrentUiContextVoiceInvocationOutcome } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import type { CurrentUiContextMountedCommand } from '@/components/appShell/currentUiContext/currentUiContextModel';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { PagePinnedBar } from '@/components/ui/layout/PagePinnedBar';
import { PageFrame } from '@/components/ui/layout/PageFrame';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { nativePickFiles } from '@/utils/files/nativePickFiles';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { t } from '@/text';
import { PluginMark } from '../PluginMark';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { usePluginPublish, githubPublicationTargetId, type PluginPublishController } from './usePluginPublish';
import { parsePluginPublishDraftPatch, type PluginPublishFields } from './pluginPublishDraft';
import { usePluginAuthoringSession } from './usePluginAuthoringSession';
import { useBotTemplateEditor } from '@/components/sessions/bots/templates/useBotTemplateEditor';
import type { BotTemplateEditorBuffer } from '@/components/sessions/bots/templates/botTemplateEditorBuffer';
import type { BotTemplateReleaseV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { PluginPublishActionInputSchema, PluginPublishStatusActionInputSchema, type PluginPublicationBotTemplate } from '@happier-dev/protocol/actions/actionSpecs';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useBotTemplatePublicationSeed } from './useBotTemplatePublicationSeed';

type TextField = { [K in keyof PluginPublishFields]: PluginPublishFields[K] extends string ? K : never }[keyof PluginPublishFields];
type CopyKey = Parameters<typeof t>[0];
const copy = (key: keyof typeof import('@/text/translations/pluginPublishTranslations').pluginPublishTranslations.en) =>
    t(`settingsPlugins.publish.${key}`);

/** Only this field subscribes to its text. The page and remote controller stay out of typing. */
function PublishField(props: Readonly<{ controller: PluginPublishController; field: TextField; label: CopyKey;
    hint?: CopyKey; multiline?: boolean; document?: boolean; monospace?: boolean; error?: string | null; children?: React.ReactNode }>) {
    const value = useStore(props.controller.draft, state => state.fields[props.field]);
    return <SectionContentRow><FieldItem label={t(props.label)} supportingText={props.hint ? t(props.hint) : undefined}>
        <FieldTextInput testID={`plugin-publish.field.${props.field}`} accessibilityLabel={t(props.label)} value={value}
            editable={!props.controller.readOnly} error={props.error}
            onChangeText={next => props.controller.draft.getState().patch({ [props.field]: next })}
            multiline={props.multiline} presentation={props.document ? 'document' : 'field'}
            monospace={props.monospace} autoCapitalize={props.monospace ? 'none' : 'sentences'} />
        {props.children}
    </FieldItem></SectionContentRow>;
}

/** One README field: the text or its preview under one label, with the switch between them beneath. */
function ReadmeField({ controller }: Readonly<{ controller: PluginPublishController }>) {
    const readme = useStore(controller.draft, state => state.fields.readme);
    const [preview, setPreview] = React.useState(false);
    return <SectionContentRow><FieldItem label={copy('readme')}>
        {preview ? <View style={styles.readmePreview}><MarkdownView markdown={readme} selectable /></View>
            : <FieldTextInput testID="plugin-publish.field.readme" accessibilityLabel={copy('readme')} value={readme} editable={!controller.readOnly}
                onChangeText={next => controller.draft.getState().patch({ readme: next })} multiline presentation="document" />}
        <View style={styles.fieldAction}>
            <RoundButton size="small" display="secondary" title={preview ? t('common.edit') : copy('preview')}
                onPress={() => setPreview(value => !value)} />
        </View>
    </FieldItem></SectionContentRow>;
}

export function PluginPublishPackageSection({ controller, botTemplate }: Readonly<{
    controller: Pick<PluginPublishController, 'preparation' | 'pending' | 'available' | 'prepare'>;
    botTemplate?: PluginPublicationBotTemplate;
}>) {
    const [filesOpen, setFilesOpen] = React.useState(false);
    const report = controller.preparation;
    const busy = controller.pending !== null;
    return <ItemGroup title={copy('package')} description={copy('packageDescription')} action={
        <RoundButton testID="plugin-publish.prepare" title={copy('prepare')} size="small" display="secondary"
            loading={controller.pending === 'prepare'} disabled={busy || !controller.available} onPress={() => { void controller.prepare(); }} />
    }>
        <Item title={copy('check')} detail={report?.stages?.validation ? copy(report.stages.validation === 'passed' ? 'passed' : 'failed') : undefined} mode="info" showChevron={false} />
        <Item title={copy('build')} detail={report?.stages?.build ? copy(report.stages.build === 'passed' ? 'passed' : report.stages.build === 'not_configured' ? 'notConfigured' : 'failed') : undefined} mode="info" showChevron={false} />
        <Item title={copy('pack')} detail={report ? `${report.files.length} · ${report.archiveSizeBytes.toLocaleString()} B` : undefined}
            subtitle={report?.sdkVersion ? `SDK ${report.sdkVersion}` : undefined} mode="info" showChevron={false} />
        {botTemplate ? <Item testID="plugin-publish.template-check" title={t('botTemplates.templateCheck')}
            subtitle={t('botTemplates.templateCheckDescription')}
            detail={[t('botTemplates.getsSkills', { count: botTemplate.release.content.skills.length }),
                t('botTemplates.getsMemory', { count: botTemplate.release.content.memoryRules.length })].join(' · ')}
            mode="info" showChevron={false} /> : null}
        {report?.tests ? <Item title={copy(report.tests.status === 'passed' ? 'testsPassed' : report.tests.status === 'failed' ? 'testsFailed' : 'noTests')}
            mode="info" showChevron={false} /> : null}
        {report ? <ExpandableItem expanded={filesOpen} onExpandedChange={setFilesOpen} testID="plugin-publish.files"
            header={({ expanded, toggle }) => <Item title={copy('viewFiles')} detail={String(report.files.length)}
                onPress={toggle} accessibilityExpanded={expanded} /> }>
            {report.files.map(file => <Item key={file.path} title={file.path} detail={`${file.sizeBytes.toLocaleString()} B`}
                mode="info" showChevron={false} />)}
        </ExpandableItem> : null}
    </ItemGroup>;
}

/** The Store listing's mark size, so the icon reads here as it will in the Store. */
const LISTING_FACE_SIZE = 26;

function IconField({ controller, identity }: Readonly<{ controller: PluginPublishController;
    identity?: PluginPublicationBotTemplate['release']['content']['identity'] }>) {
    const icon = useStore(controller.draft, state => state.fields.icon);
    const dataBase64 = useStore(controller.draft, state => state.fields.iconDataBase64);
    const bytes = React.useMemo(() => dataBase64 ? decodeBase64(dataBase64) : undefined, [dataBase64]);
    const [picking, setPicking] = React.useState(false);
    const [error, setError] = React.useState(false);
    const [open, setOpen] = React.useState(false);
    const resources = controller.inspection?.resources?.filter(resource => resource.contentType === 'image/png') ?? [];
    async function pick() {
        setPicking(true); setError(false);
        try {
            const [picked] = await nativePickFiles({ type: 'image/png', multiple: false });
            if (!picked) return;
            const selected = picked.kind === 'web' ? new Uint8Array(await picked.file.arrayBuffer()) : await new File(picked.uri).bytes();
            controller.draft.getState().patch({ iconDataBase64: encodeBase64(selected) });
        } catch { setError(true); } finally { setPicking(false); }
    }
    return <>
        <Item title={copy('icon')} subtitle={error ? copy('iconPickFailed') : copy('iconPng')}
            icon={bytes ? <HappierBrandMark brand={{ displayName: identity?.name ?? copy('title'), bytes }} externallyLabelled />
                : identity ? <SessionBotFace facts={{ seed: identity.name, face: identity.face ?? null }} size={LISTING_FACE_SIZE} motion={false} />
                : <PluginMark title={copy('title')} />}
            showChevron={false} mode="info" rightElement={<RoundButton title={copy('chooseIcon')} size="small" display="secondary"
                loading={picking} disabled={picking || controller.pending !== null} onPress={() => { void pick(); }} />} />
        {resources.length ? <DropdownMenu testID="plugin-publish.icon" open={open} onOpenChange={setOpen} selectedId={dataBase64 ? null : icon || null}
        itemTrigger={{ title: copy('icon'), icon: <PluginMark title={copy('title')} />, disabled: controller.pending !== null,
            subtitle: resources.length ? undefined : copy('noIconResources') }}
        items={resources.map(resource => ({ id: resource.id, title: resource.path, subtitle: resource.id }))}
        onSelect={id => controller.draft.getState().patch({ icon: id, iconDataBase64: '' })} /> : null}
    </>;
}

function PublishToggle(props: Readonly<{ controller: PluginPublishController;
    field: 'github' | 'push' | 'release' | 'commit' | 'createRepository'; title: string; onEnabled?: () => void }>) {
    const value = useStore(props.controller.draft, state => state.fields[props.field]);
    return <Item title={props.title} showChevron={false} rightElement={<Switch accessibilityLabel={props.title} value={value}
        disabled={props.controller.pending !== null} onValueChange={next => {
            props.controller.draft.getState().patch({ [props.field]: next });
            if (next) props.onEnabled?.();
        }} />} />;
}

function GithubSection({ controller }: Readonly<{ controller: PluginPublishController }>) {
    const enabled = useStore(controller.draft, state => state.fields.github);
    const createRepository = useStore(controller.draft, state => state.fields.createRepository);
    const owner = useStore(controller.draft, state => state.fields.githubOwner);
    const push = useStore(controller.draft, state => state.fields.push);
    const commit = useStore(controller.draft, state => state.fields.commit);
    const [ownersOpen, setOwnersOpen] = React.useState(false);
    const github = controller.inspection?.github;
    const targets = github?.publishTargets?.success ? github.publishTargets.targets.filter(target =>
        target.provider.kind === 'github' && target.supportedVisibilities.includes('public')) : [];
    return <ItemGroup title={copy('github')} description={copy('githubDescription')}>
        <PublishToggle controller={controller} field="github" title={copy('githubEnable')}
            onEnabled={() => { if (!github) void controller.inspect(undefined, true); }} />
        {enabled ? <>
            {!github || github.status === 'unavailable' ? <Item title={copy('githubUnavailableReason')}
                subtitle={github?.reason} mode="info" showChevron={false} rightElement={<RoundButton title={copy('githubOptions')}
                    display="secondary" size="small" disabled={controller.pending !== null || !controller.available}
                    onPress={() => { void controller.inspect(undefined, true); }} />} /> : null}
            {github?.repository && !createRepository ? <Item title={copy('repository')} detail={github.repository.repository}
                subtitle={github.repository.deployment} mode="info" showChevron={false} /> : null}
            {!github?.repository && !createRepository ? <>
                <PublishField controller={controller} field="repositoryDeployment" label="settingsPlugins.publish.github" monospace />
                <PublishField controller={controller} field="repository" label="settingsPlugins.publish.repository" monospace />
            </> : null}
            {controller.hasSourceProject && targets.length ? <PublishToggle controller={controller} field="createRepository" title={copy('createRepository')} /> : null}
            {createRepository ? <>
                <DropdownMenu testID="plugin-publish.github.owner" open={ownersOpen} onOpenChange={setOwnersOpen} selectedId={owner || null}
                    itemTrigger={{ title: copy('repositoryOwner'), disabled: controller.pending !== null }}
                    items={targets.map(target => ({ id: githubPublicationTargetId(target), title: target.label, subtitle: target.provider.displayName }))}
                    onSelect={id => controller.draft.getState().patch({ githubOwner: id })} />
                <PublishField controller={controller} field="repositoryName" label="settingsPlugins.publish.repositoryName" monospace />
            </> : null}
            <PublishField controller={controller} field="branch" label="settingsPlugins.publish.branch" monospace />
            {controller.hasSourceProject ? <PublishToggle controller={controller} field="push" title={copy('pushSource')} /> : null}
            {push || createRepository ? <PublishField controller={controller} field="remote" label="settingsPlugins.publish.remote" monospace /> : null}
            {push ? <>
                <PublishToggle controller={controller} field="commit" title={copy('commit')} />
                {commit ? <>
                    <PublishField controller={controller} field="commitPaths" label="settingsPlugins.publish.selectedFiles"
                        hint="settingsPlugins.publish.selectedFilesHint" multiline monospace />
                    <PublishField controller={controller} field="commitMessage" label="settingsPlugins.publish.commitMessage" multiline />
                </> : null}
            </> : null}
            <PublishToggle controller={controller} field="release" title={copy('createRelease')} />
            {github?.repository ? <>
                <SectionButtonRow><RoundButton title={copy('githubHistory')} display="secondary"
                    loading={controller.pending === 'githubHistory'} disabled={controller.pending !== null || !controller.available}
                    onPress={() => { void controller.readGithubHistory(); }} /></SectionButtonRow>
                {controller.githubHistory?.rows.map(release => <Item key={release.releaseId} title={release.name || release.tagName}
                    detail={release.tagName} subtitle={release.publishedAt ?? undefined}
                    onPress={() => { void controller.openExternal(release.webUrl); }} />)}
                {controller.githubHistory?.failure ? <Item title={copy('githubHistoryUnavailable')}
                    subtitle={controller.githubHistory.failure} mode="info" showChevron={false} /> : null}
                {controller.githubHistory?.incomplete || controller.githubHistory?.projectionTruncated || controller.githubHistory?.omittedRowCount ?
                    <Item title={copy('githubHistoryIncomplete')} mode="info" showChevron={false} /> : null}
                {controller.githubHistory?.kind === 'ready' && !controller.githubHistory.rows.length ?
                    <Item title={copy('githubHistoryEmpty')} mode="info" showChevron={false} /> : null}
                {controller.githubHistory?.continuation ? <SectionButtonRow><RoundButton title={copy('loadMore')} display="secondary"
                    disabled={controller.pending !== null || !controller.available}
                    onPress={() => { void controller.readGithubHistory(controller.githubHistory?.continuation ?? undefined); }} /></SectionButtonRow> : null}
            </> : null}
        </> : null}
    </ItemGroup>;
}

const NEXT_VERSION_KINDS = ['patch', 'minor', 'major'] as const;

/** The next-version choice reflects the version field: the segment whose suggestion it holds, or none for a typed version. */
function NextVersionChoice({ controller }: Readonly<{ controller: PluginPublishController }>) {
    const version = useStore(controller.draft, state => state.fields.version);
    const next = controller.inspection?.nextVersions;
    if (!next) return null;
    const active: string = NEXT_VERSION_KINDS.find(kind => next[kind] === version) ?? '';
    return <SectionContentRow><SegmentedTabBar<string> tabs={NEXT_VERSION_KINDS.map(kind => ({ id: kind, label: copy(kind) }))}
        activeTabId={active} accessibilityLabel={copy('version')} role="radiogroup" disabled={controller.pending !== null}
        onSelectTab={kind => { const suggested = next[kind as typeof NEXT_VERSION_KINDS[number]]; if (suggested) controller.draft.getState().patch({ version: suggested }); }} />
    </SectionContentRow>;
}

/** npm's refusal of an occupied version sits at the version field, with the inspected next version as the one fix. */
function VersionField({ controller }: Readonly<{ controller: PluginPublishController }>) {
    const version = useStore(controller.draft, state => state.fields.version);
    const taken = controller.takenVersion !== null && version.trim() === controller.takenVersion;
    const next = controller.inspection?.nextVersions?.patch;
    return <PublishField controller={controller} field="version" label="settingsPlugins.publish.version" monospace
        error={taken ? copy('versionConflict') : null}>
        {taken && next && next !== version.trim() ? <View style={styles.fieldAction}>
            <RoundButton testID="plugin-publish.version.next" size="small" display="secondary"
                title={t('settingsPlugins.publish.useVersion', { version: next })} disabled={controller.pending !== null}
                onPress={() => controller.draft.getState().patch({ version: next })} />
        </View> : null}
    </PublishField>;
}

function VersionSection({ controller }: Readonly<{ controller: PluginPublishController }>) {
    return <ItemGroup title={copy('versionAndNotes')}>
        <VersionField controller={controller} />
        <NextVersionChoice controller={controller} />
        <PublishField controller={controller} field="changelog" label="settingsPlugins.publish.changelog" multiline document />
    </ItemGroup>;
}

function NpmSection({ controller }: Readonly<{ controller: PluginPublishController }>) {
    const [profilesOpen, setProfilesOpen] = React.useState(false);
    return <ItemGroup title={copy('npm')} description={copy('npmDescription')}>
        {controller.inspection?.profiles.length ? <DropdownMenu testID="plugin-publish.profile" open={profilesOpen} onOpenChange={setProfilesOpen}
            selectedId={controller.profile?.profileId ?? null} itemTrigger={{ title: copy('npmProfile'), disabled: controller.pending !== null }}
            items={controller.inspection.profiles.map(profile => ({ id: profile.profileId, title: profile.displayName, subtitle: profile.origin }))}
            onSelect={profileId => controller.selectProfile(profileId)} /> : null}
        <Item title={controller.profile?.displayName ?? copy('connect')} subtitle={controller.profile?.origin ?? copy('signInRequired')}
            showChevron={false} mode="info" rightElement={<RoundButton title={copy(controller.profile ? 'change' : 'connect')}
                size="small" display="secondary" disabled={!controller.available || controller.pending !== null}
                onPress={() => { void controller.connect(); }} />} />
        <PublishField controller={controller} field="packageName" label="settingsPlugins.publish.coordinate"
            hint="settingsPlugins.publish.public" monospace />
        <SectionContentRow><FieldItem label={copy('publicationMode')} supportingText={controller.mode === 'staged' ? copy('stageHint') : undefined}>
            <SegmentedTabBar tabs={[{ id: 'direct', label: copy('direct') }, { id: 'staged', label: copy('staged') }]}
                activeTabId={controller.mode} onSelectTab={controller.setMode} accessibilityLabel={copy('publicationMode')}
                role="radiogroup" disabled={controller.pending !== null} />
        </FieldItem></SectionContentRow>
    </ItemGroup>;
}

function PublicationResult({ controller, onScaffold }: Readonly<{ controller: PluginPublishController; onScaffold?: () => void }>) {
    const result = controller.result;
    if (!result && !controller.error) return null;
    if (result?.status === 'version_conflict' && !controller.error && !controller.published) return null;
    const titles = {
        published: 'published', awaiting_maintainer: 'awaitingMaintainer', outcome_unknown: 'outcomeUnknown',
        version_conflict: 'versionConflict', authentication_required: 'authenticationRequired', authentication_failed: 'authenticationRequired',
        challenge: 'challenge', failed: 'failed', cancelled: 'cancelled', missing: 'missing', review_required: 'reviewRequired',
    } as const;
    const effect = result && result.status !== 'review_required' && !('diagnostics' in result) ? result : null;
    return <ItemGroup title={copy(result ? titles[result.status] : 'failed')}>
        {controller.published && result?.status !== 'published' ? <Item title={copy('published')}
            detail={`${controller.published.packageName ?? ''}@${controller.published.version ?? ''}`} mode="info" showChevron={false} /> : null}
        <SectionContentRow><View accessibilityLiveRegion="polite" testID="plugin-publish.result">
            {result?.status === 'published' ? <Text>{copy('indexLag')}</Text> : null}
            {result?.status === 'outcome_unknown' ? <Text>{copy('outcomeUnknownBody')}</Text> : null}
            {controller.attempt?.githubOutcomeUnconfirmed ? <Text>{copy('githubReviewUnknown')}</Text> : null}
            {controller.error ? <Text selectable>{controller.error === 'publication_github_selection_required'
                ? copy('githubSelectionRequired') : controller.error}</Text> : null}
            {effect?.packageName ? <Text selectable>{`${effect.packageName}@${effect.version ?? ''}`}</Text> : null}
            {effect?.code ? <Text selectable>{effect.code}</Text> : null}
            {result && 'diagnostics' in result ? result.diagnostics.map((diagnostic, index) => <Text selectable key={`${diagnostic.code}:${index}`}>{diagnostic.message}</Text>) : null}
        </View></SectionContentRow>
        <SectionButtonRow>
            {onScaffold && result && 'diagnostics' in result && result.diagnostics.some(diagnostic => diagnostic.code === 'publication_scaffold_required') ?
                <RoundButton testID="plugin-publish.scaffold" title={copy('scaffoldSource')} display="secondary"
                    disabled={controller.pending !== null || !controller.available} onPress={onScaffold} /> : null}
            {effect?.packageUrl ? <RoundButton title={copy('openNpm')} display="secondary" onPress={() => { void controller.openExternal(effect.packageUrl!); }} /> : null}
            {effect?.reviewUrl ? <RoundButton title={copy('reviewNpm')} display="secondary" onPress={() => { void controller.openExternal(effect.reviewUrl!); }} /> : null}
            {controller.attempt?.integrity ? <RoundButton testID="plugin-publish.status" title={copy('checkPublication')} display="secondary"
                disabled={controller.pending !== null || !controller.available} onPress={() => { void controller.checkPublication(); }} /> : null}
            {result && ['authentication_required', 'authentication_failed', 'challenge'].includes(result.status) ? <RoundButton title={copy('connect')}
                display="secondary" onPress={() => { void controller.connect(); }} /> : null}
        </SectionButtonRow>
        {controller.canContinueGithub ? <SectionButtonRow>
            <RoundButton title={copy('continueGithub')} display="secondary" disabled={controller.pending !== null || !controller.available}
                onPress={() => { void controller.retryGithub(); }} />
        </SectionButtonRow> : null}
        {effect?.github ? <Item title={effect.github.status === 'published' ? copy('github') : copy('githubFailed')}
            subtitle={effect.github.errorCode} detail={effect.github.status} mode="info" showChevron={false}
            rightElement={effect.github.releaseUrl || effect.github.repositoryUrl ? <RoundButton title={copy('openGithub')} size="small"
                display="secondary" onPress={() => { void controller.openExternal(effect.github?.releaseUrl ?? effect.github?.repositoryUrl ?? ''); }} /> : undefined} /> : null}
        {effect?.github && effect.github.status !== 'published' ? <SectionButtonRow>
            {effect.github.status === 'outcome_unknown' ? <Text>{copy('githubReviewUnknown')}</Text> :
                <RoundButton title={copy('retryGithub')} display="secondary" disabled={controller.pending !== null || !controller.available}
                    onPress={() => { void controller.retryGithub(); }} />}
        </SectionButtonRow> : null}
    </ItemGroup>;
}

/** Refresh is the section's own action; the sheet appears once there are versions to list. */
function PublishedVersions({ controller }: Readonly<{ controller: PluginPublishController }>) {
    const history = controller.inspection?.history;
    const versions = history?.versions ?? [];
    return <ItemGroup title={copy('history')} description={copy('historyDescription')} surface={versions.length ? undefined : 'none'}
        action={<RoundButton title={t('common.refresh')} size="small" display="secondary" disabled={!controller.available || controller.pending !== null}
            onPress={() => { void controller.inspect(); }} />}>
        {versions.map(version => <Item key={version.version} title={version.version}
            detail={version.publishedAt} subtitle={version.integrity} mode={version.versionUrl ? 'interactive' : 'info'}
            showChevron={Boolean(version.versionUrl)} onPress={version.versionUrl ? () => { void controller.openExternal(version.versionUrl!); } : undefined} />)}
        {history?.cursor ? <SectionButtonRow><RoundButton title={copy('loadMore')} display="secondary"
            disabled={controller.pending !== null} onPress={() => { void controller.inspect(history.cursor); }} /></SectionButtonRow> : null}
    </ItemGroup>;
}

function PublishFooter({ controller }: Readonly<{ controller: PluginPublishController }>) {
    const github = useStore(controller.draft, state => state.fields.github);
    const push = useStore(controller.draft, state => state.fields.push);
    const release = useStore(controller.draft, state => state.fields.release);
    const createRepository = useStore(controller.draft, state => state.fields.createRepository);
    const commit = useStore(controller.draft, state => state.fields.commit);
    const versionTaken = useStore(controller.draft, state => controller.takenVersion !== null && state.fields.version.trim() === controller.takenVersion);
    // When Publish is off for a reason the person can fix, the sentence names only that reason.
    const reason = controller.pending ? null : controller.available && !controller.profile ? copy('signInToPublish')
        : versionTaken ? copy('versionTakenReason') : null;
    // The sentence says exactly what will happen; the one primary closes the bar at the far edge.
    return <PagePinnedBar><PageFrame content="column" column="reading" style={styles.footerColumn}><SectionButtonRow trailing={<>
        {controller.pending ? <RoundButton title={t('common.cancel')} display="secondary" onPress={controller.cancel} /> : null}
        <RoundButton testID="plugin-publish.submit"
            title={controller.pending === 'publish' ? copy('publishing')
                : controller.preparation ? `${copy('publish')} ${controller.preparation.version}` : copy('publish')}
            disabled={!controller.available || !controller.profile || !controller.canPublish || controller.pending !== null}
            loading={controller.pending === 'publish'} onPress={() => { void controller.publishSelected(); }} />
    </>}>
        {reason ? <Text variant="body" style={styles.footerSummary} testID="plugin-publish.footer.reason">{reason}</Text>
            : <Text variant="body" style={styles.footerSummary}>{copy(controller.currentPreparation ? 'publishReview' : 'prepareRequired')}
            {controller.preparation ? ` ${controller.preparation.packageName}@${controller.preparation.version} · ${copy('public')}` : ''}
            {github ? ` ${[createRepository ? copy('createRepository') : '', push && commit ? copy('commit') : '', push ? copy('pushSource') : '', release ? copy('createRelease') : ''].filter(Boolean).join(' · ')}` : ''}</Text>}
    </SectionButtonRow></PageFrame></PagePinnedBar>;
}

function usePublisherCurrentContext(controller: PluginPublishController) {
    const invokeOperation = async (operation: Promise<Readonly<{ ok: true }> | Extract<ActionExecuteResult, { ok: false }> | undefined>): Promise<CurrentUiContextVoiceInvocationOutcome> => {
        const outcome = await operation;
        if (!outcome) return { ok: false, code: 'stale_surface' };
        return outcome.ok ? { ok: true } : { ok: false, code: 'denied', errorCode: outcome.errorCode };
    };
    const read = React.useMemo<CurrentUiContextMountedCommand>(() => ({ kind: 'hostLocal',
        invoke: () => ({ ok: true, result: { fields: controller.draft.getState().fields } }),
    }), [controller.draft]);
    useCurrentUiContextMountedCommand(read, copy('readDraft'));
    const readOnly = React.useRef(controller.readOnly);
    readOnly.current = controller.readOnly;
    const patch = React.useMemo<CurrentUiContextMountedCommand>(() => ({ kind: 'hostLocal',
        invoke: ({ input }) => {
            if (readOnly.current) return { ok: false, code: 'unavailable', errorCode: 'publication_draft_read_only' };
            const fields = parsePluginPublishDraftPatch(input);
            if (!fields) return { ok: false, code: 'invalid_payload', errorCode: 'publication_draft_patch_invalid' };
            controller.draft.getState().patch(fields);
            return { ok: true, result: { fields: controller.draft.getState().fields } };
        },
    }), [controller.draft]);
    useCurrentUiContextMountedCommand(patch, copy('patchDraft'));
    const idle = controller.pending === null;
    const commands: CurrentUiContextLocalCommand[] = [];
    if (controller.available && idle) {
        commands.push(
            { key: 'plugin-publish.prepare', title: copy('prepare'), invoke: (_, _context, invocation) => invokeOperation(controller.prepare(invocation)) },
            { key: 'plugin-publish.connect', title: copy(controller.profile ? 'change' : 'connect'), invoke: (_, _context, invocation) => invokeOperation(controller.connect(invocation)) },
            { key: 'plugin-publish.refresh', title: t('common.refresh'), invoke: (_, _context, invocation) => invokeOperation(controller.inspect(undefined, false, undefined, invocation)) },
        );
        if (controller.attempt?.integrity) commands.push({ key: 'plugin-publish.status', title: copy('checkPublication'), invoke: (_, _context, invocation) => invokeOperation(controller.checkPublication(invocation)) });
        if (controller.profile && controller.canPublish) commands.push({ key: 'plugin-publish.publish', title: copy('publish'), invoke: (_, _context, invocation) => invokeOperation(controller.publishSelected(invocation)) });
        if (controller.canContinueGithub) commands.push({ key: 'plugin-publish.retry-github', title: copy('continueGithub'), invoke: (_, _context, invocation) => invokeOperation(controller.retryGithub(invocation)) });
        if (controller.inspection?.github?.repository) commands.push({ key: 'plugin-publish.github-history', title: copy('githubHistory'), invoke: (_, _context, invocation) => invokeOperation(controller.readGithubHistory(undefined, invocation)) });
        if (controller.githubHistory?.continuation) commands.push({ key: 'plugin-publish.github-history-more', title: `${copy('githubHistory')} · ${copy('loadMore')}`,
            invoke: (_, _context, invocation) => invokeOperation(controller.readGithubHistory(controller.githubHistory?.continuation ?? undefined, invocation)) });
    }
    if (idle) {
        commands.push({ key: 'plugin-publish.mode', title: copy('publicationMode'), invoke: input => {
            const parsed = z.strictObject({ mode: PluginPublishActionInputSchema.shape.mode }).safeParse(input);
            if (!parsed.success) return { ok: false, code: 'invalid_payload' };
            controller.setMode(parsed.data.mode);
        } });
        if (controller.inspection?.profiles.length) commands.push({ key: 'plugin-publish.profile', title: copy('npmProfile'), invoke: (input, _context, invocation) => {
            const parsed = z.strictObject({ profileId: PluginPublishStatusActionInputSchema.shape.profileId }).safeParse(input);
            if (!parsed.success || !controller.inspection?.profiles.some(profile => profile.profileId === parsed.data.profileId)) return { ok: false, code: 'invalid_payload' };
            return invokeOperation(controller.selectProfile(parsed.data.profileId, invocation));
        } });
        if (controller.inspection?.history?.cursor) commands.push({ key: 'plugin-publish.history-more', title: `${copy('history')} · ${copy('loadMore')}`,
            invoke: (_, _context, invocation) => invokeOperation(controller.inspect(controller.inspection?.history?.cursor, false, undefined, invocation)) });
    } else commands.push({ key: 'plugin-publish.cancel', title: t('common.cancel'), invoke: controller.cancel });
    useCurrentUiContextLocalCommands(commands);
}

/** Generic publication page: the only plugin-development publish entry point. */
export function PluginPublishScreen() {
    const params = useLocalSearchParams<{ projectRoot?: string; machineId?: string; serverIdentityId?: string;
        templateArtifactId?: string; templateServerId?: string }>();
    const projectRoot = typeof params.projectRoot === 'string' ? params.projectRoot : '';
    const initialTarget = React.useMemo(() => typeof params.machineId === 'string' && typeof params.serverIdentityId === 'string'
        ? { machineId: params.machineId, serverIdentityId: params.serverIdentityId } : null, [params.machineId, params.serverIdentityId]);
    return typeof params.templateArtifactId === 'string' && typeof params.templateServerId === 'string'
        ? <BotTemplatePublisher key={`${params.templateServerId}:${params.templateArtifactId}`} artifactId={params.templateArtifactId}
            serverId={params.templateServerId} projectRoot={projectRoot} initialTarget={initialTarget} />
        : <PluginPublishForm projectRoot={projectRoot} initialTarget={initialTarget} />;
}

function BotTemplatePublisher(props: Readonly<{ artifactId: string; serverId: string; projectRoot: string;
    initialTarget: MachineAdministrationTargetV1 | null }>) {
    const editor = useBotTemplateEditor(props.artifactId, props.serverId);
    if (!editor.buffer || !editor.scope) return <SurfaceStateCard kind={editor.failed ? 'error' : 'loading'}
        title={t(editor.failed ? 'botTemplates.unavailable' : 'common.loading')}
        action={editor.failed ? { label: t('common.retry'), onPress: editor.retry } : undefined} />;
    return <SavedTemplatePublisher {...props} key={`${editor.scope.serverId}:${editor.scope.accountId}:${props.artifactId}`}
        buffer={editor.buffer} scope={editor.scope} />;
}

function SavedTemplatePublisher(props: Readonly<{ artifactId: string; serverId: string; projectRoot: string; buffer: BotTemplateEditorBuffer;
    scope: ServerAccountScope;
    initialTarget: MachineAdministrationTargetV1 | null }>) {
    const publication = useBotTemplatePublicationSeed(props);
    useCurrentUiContextLocalCommands(publication.failed ? [{ key: 'plugin-publish.retry-template', title: t('common.retry'),
        invoke: publication.retry }] : []);
    if (!publication.seed) return <SurfaceStateCard kind={publication.failed ? 'error' : 'loading'}
        title={t(publication.failed ? 'botTemplates.unavailable' : 'common.loading')}
        action={publication.failed ? { label: t('common.retry'), onPress: publication.retry } : undefined} />;
    return <PluginPublishForm projectRoot={props.projectRoot} initialTarget={props.initialTarget} {...publication.seed}
        sourceScope={props.scope} />;
}

function PluginPublishForm({ projectRoot, initialTarget, botTemplate, previousRelease, sourceScope }: Readonly<{ projectRoot: string;
    initialTarget?: MachineAdministrationTargetV1 | null; botTemplate?: PluginPublicationBotTemplate;
    previousRelease?: BotTemplateReleaseV1 | null; sourceScope?: ServerAccountScope }>) {
    const controller = usePluginPublish({ projectRoot, initialTarget, botTemplate, previousRelease, sourceScope });
    const target = controller.administration.executionTarget;
    const identity = botTemplate?.release.content.identity;
    const openAuthoring = usePluginAuthoringSession({ serverId: target?.serverId ?? null, machineId: target?.machine.id ?? null });
    function scaffoldSource() {
        const resolved = controller.scaffold;
        if (resolved) openAuthoring({ sessionDirectory: resolved.sessionDirectory,
            promptText: `${resolved.sourceRootPath}\n\n${copy('scaffoldPrompt')}` });
    }
    usePublisherCurrentContext(controller);
    return <View style={{ flex: 1 }}>
        <ItemList keyboardAware keyboardShouldPersistTaps="handled" testID="plugin-publish.screen">
            <SettingsPageHeader title={identity ? t('settingsPlugins.publish.templateTitle', { name: identity.name }) : copy('title')}
                description={identity ? t('settingsPlugins.publish.templateSubtitle', { name: identity.name }) : copy('subtitle')} actions={
                <MachineAdministrationTargetSelector selection={controller.administration.selection} presentation="chip"
                    testIDPrefix="plugin-publish.machine" disabled={controller.pending !== null} />
            } />
            {identity ? null : <ItemGroup surface="none"><Item title={projectRoot ? formatPathRelativeToHome(projectRoot,
                controller.administration.executionTarget?.machine.metadata?.homeDir) : copy('unavailable')} mode="info" showChevron={false} /></ItemGroup>}
            <PluginPublishPackageSection controller={controller} botTemplate={botTemplate} />
            <ItemGroup title={copy('listing')} description={copy('listingDescription')}>
                <IconField controller={controller} identity={identity} />
                <PublishField controller={controller} field="title" label="settingsPlugins.publish.name" />
                <PublishField controller={controller} field="description" label="settingsPlugins.publish.description" multiline />
                <PublishField controller={controller} field="keywords" label="settingsPlugins.publish.keywords" hint="settingsPlugins.publish.keywordsHint" />
                <ReadmeField controller={controller} />
            </ItemGroup>
            <VersionSection controller={controller} />
            <NpmSection controller={controller} />
            <GithubSection controller={controller} />
            <PublicationResult controller={controller} onScaffold={controller.scaffold ? scaffoldSource : undefined} />
            <PublishedVersions controller={controller} />
        </ItemList>
        <PublishFooter controller={controller} />
    </View>;
}

const styles = StyleSheet.create(theme => ({
    // The bar's column is the page's reading column less its sheet inset, so the sentence starts on the sections' edge.
    footerColumn: { paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx },
    readmePreview: { minHeight: theme.space.s48 },
    fieldAction: { alignSelf: 'flex-start', marginTop: theme.space.s8 },
    footerSummary: { flexShrink: 1, color: theme.colors.text.secondary },
}));
