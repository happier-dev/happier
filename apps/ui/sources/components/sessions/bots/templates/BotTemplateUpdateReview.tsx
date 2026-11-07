import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { resolveThreeWayTextV1, BotTemplateUpdateFailureDetailsV1Schema, type BotTemplateUpdateApplyInputV1,
    type BotTemplateUpdateDiffResultV1, type BotTemplateSetupSelectionsV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import type { BotTemplateSourceSessionRefV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import type { ThreeWayTextChoiceV1, ThreeWayTextComparisonV1 } from '@happier-dev/protocol/diff/threeWayText';
import type { SkillUpdateFileV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { readSessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotFaceV1';
import { useSessionSelector } from '@/sync/store/hooks';
import { useHydrateSession } from '@/hooks/session/useHydrateSessionForRoute';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { readSkillText } from '@/components/settings/skills/detail/skillFileContent';
import { readSkillFrontmatterV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_IDS } from '@/agents/catalog/catalog';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { t } from '@/text';
import { BotTemplateHeader } from './BotTemplateHeader';
import { BotTemplatePinnedFooter } from './BotTemplatePageLayout';
import { BotTemplateFilePreview } from './BotTemplatePreview';
import { useBotTemplateUpdate } from './useBotTemplateUpdate';
import { BotTemplateSetup, EMPTY_BOT_TEMPLATE_SETUP, getBotTemplateSetupReadiness } from './BotTemplateSetup';
import { BotTemplateReviewDraftPatchSchema, useBotTemplateDraftCommands } from './useBotTemplateDraftCommands';

type SkillSelection = NonNullable<BotTemplateUpdateApplyInputV1['skills']>[string];
type TextChoices = Readonly<Record<string, ThreeWayTextChoiceV1>>;
const inactiveDraft = () => false;
type EditedControl = Readonly<{ setValue(value: string): void }>;

function reviewSkillSelections(review: BotTemplateUpdateDiffResultV1['skills'], selections: Readonly<Partial<Record<string, SkillSelection>>>) {
    return Object.fromEntries(review.map(skill => [skill.key, {
        choice: skill.status === 'added' || skill.status === 'existing' ? 'take' as const : skill.status === 'removed' ? 'keep' as const : 'skip' as const,
        ...(skill.revision ? { expectedRevision: skill.revision } : {}), ...selections[skill.key],
    }]));
}

export function BotTemplateUpdateReview({ sessionRef }: Readonly<{ sessionRef: BotTemplateSourceSessionRefV1 }>) {
    const update = useBotTemplateUpdate(sessionRef);
    if (!update.review) return <SurfaceStateCard testID="bot-template-update-load" kind={update.errorCode ? 'error' : 'loading'}
        title={update.errorCode ? t('botTemplates.unavailable') : t('common.loading')} diagnosticCode={update.errorCode ?? undefined}
        action={update.errorCode ? { label: t('common.retry'), onPress: update.reload } : undefined} />;
    return <LoadedUpdateReview key={JSON.stringify([update.execution.binding?.scope, update.execution.binding?.revision,
        update.review.sessionRef, update.review.metadataRevision, update.review.upstream.revision,
        update.review.upstream.release.version, update.review.instructions?.revision, update.review.skills.map(skill => [skill.key, skill.revision])])}
        review={update.review} update={update} />;
}

type UpdateControls = Pick<ReturnType<typeof useBotTemplateUpdate>, 'mutation' | 'errorCode' | 'reload' | 'apply' | 'skip' | 'stop'>;
type UpdateSetup = Readonly<{ value: BotTemplateSetupSelectionsV1; ready: boolean; content: React.ReactNode;
    onChange?: (value: BotTemplateSetupSelectionsV1) => void }>;

function LoadedUpdateReview({ review, update }: Readonly<{ review: BotTemplateUpdateDiffResultV1; update: ReturnType<typeof useBotTemplateUpdate> }>) {
    const [selections, setSelections] = React.useState(EMPTY_BOT_TEMPLATE_SETUP);
    const [softwareValid, setSoftwareValid] = React.useState(true);
    const machineId = review.executionTarget?.machineId ?? null;
    const presence = useMachinePresenceSummary(review.sessionRef.serverId, machineId, update.execution.binding);
    // A direct load reaches this page before the Bot's Session is in the store; its name and face lead the header.
    useHydrateSession(review.sessionRef.sessionId, 'botTemplate.updateReview', { serverId: review.sessionRef.serverId, hydrateMessages: false });
    const readiness = getBotTemplateSetupReadiness(review.needs, selections);
    return <BotTemplateUpdateForm review={review} update={update} ready={update.execution.ready} isCurrent={update.execution.isCurrent}
        setup={{ value: selections, onChange: setSelections, ready: readiness.ready && softwareValid, content: <BotTemplateSetup needs={review.needs}
            value={selections} onChange={setSelections} machineId={machineId} serverId={review.sessionRef.serverId}
            machineOnline={presence.reachability === 'unknown' ? null : presence.reachability === 'reachable'}
            execution={update.execution} onValidityChange={setSoftwareValid} /> }} />;
}

/** The reviewed owner result drives every choice; the page never reconstructs a merge base. */
export function BotTemplateUpdateForm({ review, update, ready, setup, isCurrent = inactiveDraft }: Readonly<{ review: BotTemplateUpdateDiffResultV1;
    update: UpdateControls; ready: boolean; setup?: UpdateSetup; isCurrent?: () => boolean }>) {
    const [instructions, setInstructions] = React.useState<TextChoices>({});
    const [skills, setSkills] = React.useState<Readonly<Partial<Record<string, SkillSelection>>>>({});
    const reviewedSkills = React.useMemo(() => reviewSkillSelections(review.skills, skills), [review.skills, skills]);
    const [takeIdentity, setTakeIdentity] = React.useState(false);
    const edited = React.useRef<Readonly<{ source: string; markdown: string }> | null>(null);
    const editor = React.useRef<EditedControl | null>(null);
    const preview = React.useMemo(() => review.instructions
        ? resolveThreeWayTextV1(review.instructions.comparison, instructions) : '', [review.instructions, instructions]);
    const accepted = review.acceptedSuggestions;
    const offered = review.upstream.release.content;
    const firstTaskChanged = accepted.firstTask !== offered.firstTask;
    const agentChanged = accepted.suggestedAgent?.agentId !== offered.suggestedAgent?.agentId
        || accepted.suggestedAgent?.modelId !== offered.suggestedAgent?.modelId;
    const busy = ['applying', 'skipping', 'stopping'].includes(update.mutation.kind);
    const finished = ['updated', 'skipped', 'stopped'].includes(update.mutation.kind);
    const latest = React.useRef({ instructions, skills: reviewedSkills, takeIdentity, setup, preview, busy, finished });
    latest.current = { instructions, skills: reviewedSkills, takeIdentity, setup, preview, busy, finished };
    useBotTemplateDraftCommands({ kind: 'review', isCurrent,
        read: () => {
            const current = latest.current;
            return { instructions: current.instructions, skills: current.skills, takeIdentity: current.takeIdentity,
                editedInstructions: edited.current?.source === current.preview ? edited.current.markdown : null,
                selections: current.setup?.value ?? EMPTY_BOT_TEMPLATE_SETUP,
                reviewContext: { sessionRef: review.sessionRef, metadataRevision: review.metadataRevision,
                    source: review.upstream.source, version: review.upstream.release.version, revision: review.upstream.revision ?? null,
                    instructionsRevision: review.instructions?.revision ?? null,
                    skills: review.skills.map(skill => ({ key: skill.key, status: skill.status, canTake: skill.canTake, revision: skill.revision ?? null })), needs: review.needs } };
        },
        patch: value => {
            const parsed = BotTemplateReviewDraftPatchSchema.safeParse(value);
            const current = latest.current;
            if (!parsed.success || current.busy || current.finished || review.offer !== 'available') return false;
            const next = parsed.data;
            if (next.selections !== undefined && !current.setup?.onChange) return false;
            if (next.editedInstructions !== undefined && !review.instructions) return false;
            const nextInstructions = next.instructions ?? current.instructions;
            const nextPreview = review.instructions ? resolveThreeWayTextV1(review.instructions.comparison, nextInstructions) : '';
            latest.current = { ...current, instructions: nextInstructions, skills: next.skills ? reviewSkillSelections(review.skills, next.skills) : current.skills,
                takeIdentity: next.takeIdentity ?? current.takeIdentity, preview: nextPreview,
                setup: next.selections !== undefined && current.setup ? { ...current.setup, value: next.selections } : current.setup };
            if (next.instructions !== undefined) setInstructions(next.instructions);
            if (next.skills !== undefined) setSkills(next.skills);
            if (next.takeIdentity !== undefined) setTakeIdentity(next.takeIdentity);
            if (next.selections !== undefined) current.setup?.onChange?.(next.selections);
            if (next.editedInstructions !== undefined) {
                edited.current = next.editedInstructions === null ? null : { source: nextPreview, markdown: next.editedInstructions };
                editor.current?.setValue(next.editedInstructions ?? nextPreview);
            }
            return true;
        },
    });
    const apply = () => {
        const markdown = edited.current?.source === preview ? edited.current.markdown : undefined;
        void update.apply({ sessionRef: review.sessionRef, expectedVersion: review.upstream.release.version,
            ...(review.upstream.revision ? { expectedRevision: review.upstream.revision } : {}),
            ...(review.instructions ? { instructions: { expectedRevision: review.instructions.revision,
                choices: instructions, ...(markdown !== undefined ? { markdown } : {}) } } : {}),
            skills: reviewedSkills, takeIdentity, ...(setup ? { setup: setup.value } : {}) });
    };
    const choosing = review.offer === 'available' && !finished;
    const conflicts = review.instructions?.comparison.segments.filter(segment => segment.kind === 'conflict').length ?? 0;
    const botIdentity = useRecipientBotIdentity(review);
    return <View style={styles.page}>
    <ItemList keyboardAware testID="bot-template-update-review">
        {/* The recipient's own Bot leads (lab r2 update-whatsnew): this page changes it, not the template. */}
        <BotTemplateHeader identity={botIdentity}
            presentation={review.upstream.presentation}
            version={review.instance.acceptedVersion === review.upstream.release.version ? review.instance.acceptedVersion
                : `${review.instance.acceptedVersion} → v${review.upstream.release.version}`}
            actions={review.instance.follow && !finished ? <ItemRowActions title={t('common.moreActions')} overflowOnly
                overflowTriggerTestID="bot-template-update:more" actions={[{ id: 'bot-template-update:stop',
                    title: t('botTemplateRecipient.stopFollowing'), icon: 'bell-slash', disabled: busy,
                    onPress: () => { void update.stop(); } }]} /> : undefined} />
        {update.errorCode ? <SurfaceStateCard kind="error" title={t('botTemplates.unavailable')} diagnosticCode={update.errorCode}
            action={{ label: t('common.retry'), onPress: update.reload }} /> : null}
        <UpdateOutcome update={update} review={review} />
        {review.offer !== 'available' ? <SurfaceStateCard kind="empty" title={t(review.offer === 'current'
            ? 'botTemplateRecipient.currentVersion' : review.offer === 'skipped'
                ? 'botTemplateRecipient.skippedVersion' : 'botTemplateRecipient.stoppedFollowing')} /> : null}
        {/* The author's note, with the one promise that holds for every choice below said once above it (lab r2 update-whatsnew). */}
        <ItemGroup title={t('botTemplateRecipient.updatesTitle')} description={choosing ? t('botTemplateRecipient.updatePromise') : undefined}
            surface={review.upstream.release.changelog ? undefined : 'none'}>
            {review.upstream.release.changelog
                ? <SectionContentRow><Text selectable style={styles.ink}>{review.upstream.release.changelog}</Text></SectionContentRow> : null}
        </ItemGroup>
        {review.offer === 'available' && !finished ? <>
            {/* One row says it; a section title repeating the row's label would say it twice. */}
            <ItemGroup>
                <SegmentedChoiceItem title={t('botTemplateRecipient.updateIdentity')} value={takeIdentity ? 'theirs' : 'mine'}
                    options={textOptions(false)} disabled={busy} testIDPrefix="bot-template-update:identity"
                    onChange={next => setTakeIdentity(next === 'theirs')} />
            </ItemGroup>
            {firstTaskChanged ? <ItemGroup title={t('botTemplates.firstTask')}>
                <Item title={t('botTemplateRecipient.acceptedVersion', { version: review.instance.acceptedVersion })}
                    subtitle={accepted.firstTask || t('common.none')} subtitleLines={0} mode="info" showChevron={false} />
                <Item title={t('botTemplateRecipient.availableVersion', { version: review.upstream.release.version })}
                    subtitle={offered.firstTask || t('common.none')} subtitleLines={0} mode="info" showChevron={false} />
            </ItemGroup> : null}
            {agentChanged ? <ItemGroup title={t('botTemplates.suggestedAgent')} description={t('botTemplateRecipient.suggestionsDoNotSwitchAgent')}>
                <Item title={t('botTemplateRecipient.acceptedVersion', { version: review.instance.acceptedVersion })}
                    subtitle={formatAgentSuggestion(accepted.suggestedAgent)} subtitleLines={0} mode="info" showChevron={false} />
                <Item title={t('botTemplateRecipient.availableVersion', { version: review.upstream.release.version })}
                    subtitle={formatAgentSuggestion(offered.suggestedAgent)} subtitleLines={0} mode="info" showChevron={false} />
            </ItemGroup> : null}
            {/* Only what changed: lines both sides edited ask for a choice, the author's other changes are taken and
                fold into one row, and the whole resulting document waits behind its own disclosure. */}
            <ItemGroup title={t('botTemplates.instructions')} description={conflicts > 0 ? t('botTemplates.changedLinesYouEdited') : undefined}>
                {review.instructions ? <>
                    <TextConflictChoices title={t('botTemplates.instructions')} comparison={review.instructions.comparison} choices={instructions} onChange={setInstructions}
                        testID="bot-template-update:instructions" disabled={busy} />
                    <TakenChanges comparison={review.instructions.comparison} />
                    <Disclosure testID="bot-template-update:preview-disclosure" title={t('botTemplateRecipient.resultPreview')}>
                        <SectionContentRow><EditedPreview source={preview} edited={edited} control={editor} disabled={busy} /></SectionContentRow>
                    </Disclosure>
                </> : <SectionContentRow><Text style={styles.ink}>{t('botTemplateRecipient.detachedInstructions')}</Text></SectionContentRow>}
            </ItemGroup>
            {review.skills.length > 0 ? <ItemGroup title={t('botTemplateRecipient.skills')}>
                {review.skills.map(skill => <UpdateSkill key={skill.key} skill={skill} selection={reviewedSkills[skill.key]!} disabled={busy}
                    onChange={selection => setSkills(previous => ({ ...previous, [skill.key]: selection }))} />)}
            </ItemGroup> : null}
            {setup?.content}
        </> : null}
    </ItemList>
    {/* One pinned step, like setup's Create: Skip this version beside the one primary Update. */}
    {choosing ? <BotTemplatePinnedFooter column="reading" note={setup?.ready === false
        ? <Text variant="meta" style={styles.alert} accessibilityRole="alert">{t('botTemplateRecipient.setupIncomplete')}</Text>
        : <Text variant="meta" style={styles.alert} testID="bot-template-update:consequence">
            {t('botTemplates.updateConsequence', { name: botIdentity.name, version: review.upstream.release.version })}</Text>}>
        <RoundButton title={t('botTemplateRecipient.skipVersion')} testID="bot-template-update:skip" display="secondary" disabled={busy}
            onPress={() => { void update.skip(review.upstream.release.version); }} />
        <RoundButton title={t('botTemplateRecipient.update')} testID="bot-template-update:apply"
            disabled={busy || !ready || setup?.ready === false || Boolean(update.errorCode)} loading={update.mutation.kind === 'applying'} onPress={apply} />
    </BotTemplatePinnedFooter> : null}
    </View>;
}

function formatAgentSuggestion(suggestion: BotTemplateUpdateDiffResultV1['acceptedSuggestions']['suggestedAgent']) {
    if (!suggestion) return t('common.none');
    const name = resolveAgentCatalogProjection(suggestion.agentId, { enabledAgentIds: AGENT_IDS }).title;
    return suggestion.modelId ? `${name} · ${suggestion.modelId}` : name;
}

function textOptions(both: boolean) {
    return [{ id: 'mine' as const, label: t('capabilities.skillDetail.instructions.keepMine') },
        { id: 'theirs' as const, label: t('capabilities.skillDetail.instructions.takeTheirs') },
        ...(both ? [{ id: 'both' as const, label: t('botTemplateRecipient.both') }] : [])];
}

function TextConflictChoices(props: Readonly<{ comparison: ThreeWayTextComparisonV1; choices: TextChoices;
    onChange: (choices: TextChoices) => void; testID: string; title: string; disabled: boolean }>) {
    return <>{props.comparison.segments.filter(segment => segment.kind === 'conflict').map(segment => <React.Fragment key={segment.index}>
        <SegmentedChoiceItem title={props.title} value={props.choices[segment.index] ?? 'mine'}
            options={textOptions(true)} disabled={props.disabled} testIDPrefix={`${props.testID}:${segment.index}`}
            onChange={choice => props.onChange({ ...props.choices, [segment.index]: choice })} />
        <SectionContentRow><DiffViewer mode="text" face="prose" oldText={segment.mine} newText={segment.theirs}
            filePath="instructions.md" wrapLines prose={{ oldLabel: t('capabilities.skillDetail.instructions.yours'),
                newLabel: t('capabilities.skillDetail.instructions.theirs'),
                kept: props.choices[segment.index] === 'theirs' ? 'new' : props.choices[segment.index] === 'both' ? null : 'old' }} /></SectionContentRow>
    </React.Fragment>)}</>;
}

/** Typing stays in the document leaf and is read once when the person presses Update. */
function EditedPreview(props: Readonly<{ source: string; edited: React.RefObject<Readonly<{ source: string; markdown: string }> | null>;
    control: React.RefObject<EditedControl | null>; disabled: boolean }>) {
    const [value, setValue] = React.useState(props.source);
    React.useLayoutEffect(() => {
        props.control.current = { setValue };
        // Closing the preview keeps what was typed; the edit stays tied to the document it was made on.
        return () => { props.control.current = null; };
    }, [props.control, props.edited]);
    React.useLayoutEffect(() => {
        if (props.edited.current?.source === props.source) setValue(props.edited.current.markdown);
        else { props.edited.current = null; setValue(props.source); }
    }, [props.edited, props.source]);
    return <FieldTextInput multiline growWithText presentation="document" value={value} editable={!props.disabled}
        accessibilityLabel={t('botTemplateRecipient.resultPreview')} testID="bot-template-update:preview"
        onChangeText={markdown => { setValue(markdown); props.edited.current = { source: props.source, markdown }; }} />;
}

function UpdateSkill(props: Readonly<{ skill: BotTemplateUpdateDiffResultV1['skills'][number]; selection: SkillSelection;
    onChange: (selection: SkillSelection) => void; disabled: boolean }>) {
    const { skill, selection, onChange, disabled } = props;
    const choice = selection.choice;
    const options = skill.status === 'removed' ? [{ id: 'keep' as const, label: t('common.keep') }, { id: 'remove' as const, label: t('common.remove') }]
        : skill.status === 'added' || skill.status === 'deleted' ? [{ id: 'skip' as const, label: t('common.skip') },
            { id: 'take' as const, label: t('common.add'), disabled: !skill.canTake,
                ...(!skill.canTake ? { unavailableReason: t('botTemplates.unavailable') } : {}) }]
            : [{ id: 'keep' as const, label: t('capabilities.skillDetail.instructions.keepMine') }, { id: 'take' as const, label: t('capabilities.skillDetail.instructions.takeTheirs') }];
    // One row per skill inside the review's single Skills section, saying what it is for (its own front matter); a new
    // skill is that row alone, an updated one is followed by the lines that changed.
    const skillDocument = skill.files.find(file => file.path === 'SKILL.md')?.theirs;
    const purpose = skillDocument?.contentKind === 'utf8' ? readSkillFrontmatterV1(readSkillText(skillDocument.contentBase64)).description : undefined;
    return <>
        <SegmentedChoiceItem<SkillSelection['choice']> title={skill.title} subtitle={purpose} icon={<Icon name="lightbulb" />}
            value={choice} options={options}
            disabled={disabled} testIDPrefix={`bot-template-update:skill:${skill.key}`}
            onChange={next => onChange({ ...selection, choice: next })} />
        {skill.status === 'added' ? null : skill.files.filter(file => file.changed).map(file => <UpdateSkillFile key={file.path} file={file} disabled={disabled || !skill.canTake}
            testID={`bot-template-update:file:${skill.key}:${file.path}`} choice={selection?.choices?.[file.path]}
            hunkChoices={selection?.hunkChoices?.[file.path]}
            onHunkChange={next => onChange({ ...selection, choice: 'take',
                hunkChoices: { ...selection?.hunkChoices, [file.path]: next } })}
            onChange={next => onChange({ ...selection, choice: 'take', choices: { ...selection?.choices, [file.path]: next } })} />)}
    </>;
}

function UpdateSkillFile(props: Readonly<{ file: SkillUpdateFileV1; choice?: ThreeWayTextChoiceV1; disabled: boolean;
    onChange: (choice: ThreeWayTextChoiceV1) => void; testID: string; hunkChoices?: TextChoices;
    onHunkChange: (choices: TextChoices) => void }>) {
    const { file } = props;
    const binary = file.mine?.contentKind === 'binary' || file.theirs?.contentKind === 'binary';
    // A file's name heads its lines only where they ask for a choice; taken changes fold into their own row.
    const asks = file.comparison?.segments.some(segment => segment.kind === 'conflict') ?? false;
    if (file.comparison && !binary) return <>
        {asks ? <Item title={file.path} mode="info" showChevron={false} /> : null}
        <TextConflictChoices title={file.path} comparison={file.comparison} choices={props.hunkChoices ?? {}}
            onChange={props.onHunkChange} testID={props.testID} disabled={props.disabled} />
        <TakenChanges comparison={file.comparison} />
    </>;
    return <>
        <SegmentedChoiceItem title={file.path} value={props.choice ?? 'mine'} options={textOptions(false)}
            disabled={props.disabled} testIDPrefix={props.testID} onChange={props.onChange} />
        <SectionContentRow>{binary ? <>
            {file.mine ? <><Text variant="label" style={styles.ink}>{t('capabilities.skillDetail.instructions.yours')}</Text>
                <BotTemplateFilePreview file={file.mine} testID={`${props.testID}:mine`} /></> : null}
            {file.theirs ? <><Text variant="label" style={styles.ink}>{t('capabilities.skillDetail.instructions.theirs')}</Text>
                <BotTemplateFilePreview file={file.theirs} testID={`${props.testID}:theirs`} /></> : null}
        </>
            : <DiffViewer mode="text" face="prose" oldText={file.mine ? readSkillText(file.mine.contentBase64) : ''}
                newText={file.theirs ? readSkillText(file.theirs.contentBase64) : ''} filePath={file.path} wrapLines
                prose={{ oldLabel: t('capabilities.skillDetail.instructions.yours'), newLabel: t('capabilities.skillDetail.instructions.theirs'),
                    kept: props.choice === 'theirs' ? 'new' : 'old' }} />}</SectionContentRow>
    </>;
}

function UpdateOutcome({ update, review }: Readonly<{ update: UpdateControls; review: BotTemplateUpdateDiffResultV1 }>) {
    const { mutation } = update;
    if (mutation.kind === 'updated') return <ItemGroup title={t('botTemplateRecipient.updated')}>
        <Item title={t('botTemplateRecipient.acceptedVersion', { version: mutation.result.acceptedVersion })} mode="info" showChevron={false} />
        <ResultRows resources={mutation.result.applied} review={review} outcome={t('botTemplateRecipient.appliedChanges')} />
        <ResultRows resources={mutation.result.kept} review={review} outcome={t('botTemplateRecipient.keptChanges')} />
    </ItemGroup>;
    if (mutation.kind === 'skipped' || mutation.kind === 'stopped') return <SectionContentRow>
        <Text style={styles.ink}>{t(mutation.kind === 'skipped' ? 'botTemplateRecipient.skippedVersion' : 'botTemplateRecipient.stoppedFollowing')}</Text>
    </SectionContentRow>;
    if (mutation.kind !== 'failed') return null;
    const partial = BotTemplateUpdateFailureDetailsV1Schema.safeParse(mutation.result.details);
    return <>
        <SurfaceStateCard kind="error" title={t('botTemplateRecipient.updateFailed')} diagnosticCode={mutation.result.errorCode}
            action={{ label: t('botTemplateRecipient.reviewAgain'), onPress: update.reload }} />
        {partial.success ? <ItemGroup>
            <ResultRows resources={partial.data.applied} review={review} outcome={t('botTemplateRecipient.appliedChanges')} />
            <ResultRows resources={partial.data.remaining} review={review} outcome={t('botTemplateRecipient.remainingChanges')} />
        </ItemGroup> : null}
    </>;
}

function ResultRows(props: Readonly<{ resources: readonly string[]; review: BotTemplateUpdateDiffResultV1; outcome: string }>) {
    return <>{props.resources.filter(resource => resource !== 'settlement').map(resource => {
        const skill = resource.startsWith('skill:') ? props.review.skills.find(skill => skill.key === resource.slice(6)) : null;
        const mcp = resource.startsWith('mcp:') ? props.review.needs.mcpServers.find(need => need.key === resource.slice(4)) : null;
        const title = resource === 'instructions' ? t('botTemplates.instructions') : resource === 'identity'
            ? t('botTemplateRecipient.updateIdentity') : resource === 'software' ? t('botTemplates.kindSoftware')
                : resource === 'accounts' ? t('botTemplates.kindAccount') : skill?.title ?? mcp?.name ?? t('botTemplateRecipient.needs');
        return <Item key={resource} title={title} detail={props.outcome} mode="info" showChevron={false} />;
    })}</>;
}

/** The recipient Bot's own name and face from its Session; the template's identity until the Session is known here. */
function useRecipientBotIdentity(review: BotTemplateUpdateDiffResultV1) {
    const { serverId, sessionId } = review.sessionRef;
    const name = useSessionSelector(sessionId, serverId, session => session ? getSessionName(session, serverId) : null);
    const rawFace = useSessionSelector(sessionId, serverId, session => session?.metadata?.botFace);
    const template = review.upstream.release.content.identity;
    return React.useMemo(() => {
        const face = readSessionBotFaceV1(rawFace);
        return { name: name ?? template.name, description: template.description, ...(face ? { face } : template.face ? { face: template.face } : {}) };
    }, [name, rawFace, template]);
}

/** The author's changes to lines the recipient never touched: taken, folded into one row that opens to show them. */
function TakenChanges({ comparison }: Readonly<{ comparison: ThreeWayTextComparisonV1 }>) {
    const taken = comparison.segments.filter(segment => segment.kind === 'theirs');
    if (taken.length === 0) return null;
    return <Disclosure testID="bot-template-update:taken" title={t('botTemplates.unchangedLines', { count: taken.length })}
        detail={t('botTemplates.taken')}>
        {taken.map(segment => <SectionContentRow key={segment.index}><DiffViewer mode="text" face="prose" oldText={segment.base}
            newText={segment.theirs} filePath="instructions.md" wrapLines prose={{ oldLabel: t('capabilities.skillDetail.instructions.yours'),
                newLabel: t('capabilities.skillDetail.instructions.theirs'), kept: 'new' }} /></SectionContentRow>)}
    </Disclosure>;
}

/** A closed-by-default row whose content mounts only while open. */
function Disclosure(props: Readonly<{ testID: string; title: string; detail?: string; children: React.ReactNode }>) {
    const [expanded, setExpanded] = React.useState(false);
    return <ExpandableItem expanded={expanded} onExpandedChange={setExpanded} testID={`${props.testID}:disclosure`}
        header={({ headerProps }) => <Item {...headerProps} testID={props.testID} title={props.title} detail={props.detail} showChevron={false} />}>
        {expanded ? props.children : null}
    </ExpandableItem>;
}

const styles = StyleSheet.create(theme => ({
    page: { flex: 1, minHeight: 0 },
    alert: { color: theme.colors.text.secondary },
    // App Text carries no colour of its own here; body copy takes the theme's ink so it reads in dark.
    ink: { color: theme.colors.text.primary },
}));
