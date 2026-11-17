import * as React from 'react';
import type { SessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { StyleSheet } from 'react-native-unistyles';
import { BotTemplateInstantiateResultV1Schema, type BotTemplatePreviewResultV1, type BotTemplateSetupSelectionsV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { readSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { projectSessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { NewSessionEmbeddedHostProvider, mergeNewSessionHostParams, type NewSessionEmbeddedHost, type NewSessionHostParams } from '@/components/sessions/new/navigation/newSessionHost';
import type { SessionSpawnNewActionExecutor } from '@/sync/ops/actions/sessionSpawnNewAction';
import { useNewSessionScreenModel } from '@/components/sessions/new/hooks/useNewSessionScreenModel';
import type { NewSessionBotCreationModel } from '@/components/sessions/new/hooks/newSessionScreenModelTypes';
import { SessionDraftHydrationBoundary } from '@/components/sessions/drafts/SessionDraftHydrationBoundary';
import { NewSessionLaunchSurface } from '@/components/sessions/new/components/NewSessionLaunchSurface';
import { NewSessionComposerCard } from '@/components/sessions/new/components/NewSessionComposerCard';
import { useComposerTextValue } from '@/components/sessions/agentInput/composerTextStore';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { NewBotDraftFace } from '@/components/sessions/bots/NewBotDraftHeader';
import { PAGE_HEADER_MARK_SLOT_SIZE_PX } from '@/components/ui/layout/PageHeaderMarkSlot';
import { View } from 'react-native';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { PortablePetFace } from '@/components/sessions/bots/face/PortablePetFace';
import { Modal } from '@/modal';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { storage } from '@/sync/domains/state/storage';
import { BotTemplateHeader } from './BotTemplateHeader';
import { BotTemplatePreview } from './BotTemplatePreview';
import { BotTemplatePageLayout, BotTemplateWhatItDoes } from './BotTemplatePageLayout';
import { t } from '@/text';
import { BotTemplateSetup, EMPTY_BOT_TEMPLATE_SETUP, getBotTemplateSetupReadiness } from './BotTemplateSetup';
import { BotTemplateSetupDraftPatchSchema, useBotTemplateDraftCommands } from './useBotTemplateDraftCommands';

type CopyProps = Readonly<{
    preview: BotTemplatePreviewResultV1;
    execution: ReturnType<typeof useMountedActionExecution>;
    params: NewSessionHostParams;
    setParams: React.Dispatch<React.SetStateAction<NewSessionHostParams | null>>;
    onVersionChanged: () => Promise<void>;
    onHandedOff: () => void;
    onCancel: () => void;
    onDownloadFile: (skillKey: string, path: string) => void;
    notice: React.ReactNode;
}>;

export default function BotTemplateCopyForm(props: CopyProps) {
    const { execution, preview, setParams, onVersionChanged } = props;
    const setup = React.useRef<BotTemplateSetupSelectionsV1>(EMPTY_BOT_TEMPLATE_SETUP);
    const releaseKey = JSON.stringify([preview.source, preview.release.version, preview.revision]);
    React.useLayoutEffect(() => { setup.current = EMPTY_BOT_TEMPLATE_SETUP; }, [releaseKey]);
    // A pet joins the library only where pets and their sync are on; elsewhere the copy keeps its own face, asked for nothing.
    const petsAvailable = usePetsAvailable();
    const executeSpawnAction = React.useCallback<SessionSpawnNewActionExecutor>(async (creation, context) => {
        const result = await execution.execute('template.instantiate', { source: preview.source,
            expectedVersion: preview.release.version, ...(preview.revision ? { expectedRevision: preview.revision } : {}),
            creation: projectSessionSpawnNewActionInputV2(creation),
            setup: petsAvailable ? setup.current : { ...setup.current, pet: false },
            ...(creation.title ? { name: creation.title } : {}), ...(creation.identity?.botFace ? { face: creation.identity.botFace } : {}),
        }, { confirmed: true, actionRequestId: context.actionRequestId, signal: context.signal });
        if (!result.ok) {
            if (result.errorCode === 'version_mismatch') await onVersionChanged();
            return result;
        }
        const parsed = BotTemplateInstantiateResultV1Schema.parse(result.result);
        const { petOutcome, ...spawned } = parsed.type === 'success' ? parsed : { ...parsed, petOutcome: undefined };
        const pet = preview.release.content.pet;
        // The new Bot's face references the pet just added; the library holds it at once, so the face draws it on arrival.
        if (petOutcome?.kind === 'added') storage.getState().upsertAccountPet(petOutcome.pet);
        // Copy succeeds with the template's own face when its pet could not join the library, and says why once.
        if (pet && petOutcome && petOutcome.kind !== 'added') {
            const bot = creation.title || preview.release.content.identity.name;
            Modal.alert(petOutcome.kind === 'library_full' ? t('petShare.copyLibraryFull', { bot })
                : petOutcome.kind === 'pet_sync_off' ? t('petShare.copySyncOff', { bot })
                    : t('petShare.copyCouldNotAdd', { name: pet.name, bot }));
        }
        return { ok: true, result: readSessionSpawnNewActionResultV1(spawned) };
    }, [execution.execute, preview, onVersionChanged, petsAvailable]);
    const host = React.useMemo<NewSessionEmbeddedHost>(() => ({
        params: props.params, targetServerId: execution.binding?.scope.serverId, demanded: true, executeSpawnAction,
        setParams: patch => setParams(current => current ? mergeNewSessionHostParams(current, patch) : current),
        openDraft: entry => setParams(current => ({ ...current, draftId: entry.draftId })),
        onHandedOff: props.onHandedOff,
    }), [props.params, execution.binding, executeSpawnAction, setParams, props.onHandedOff]);
    const draftId = typeof props.params.draftId === 'string' ? props.params.draftId : '';
    const addresses = React.useMemo(() => [{ kind: 'newSession' as const, draftId }], [draftId]);
    return <NewSessionEmbeddedHostProvider host={host}>
        <SessionDraftHydrationBoundary lifetime={execution.binding} addresses={addresses}>
            <CopyControls key={releaseKey} {...props} draftId={draftId} setup={setup} />
        </SessionDraftHydrationBoundary>
    </NewSessionEmbeddedHostProvider>;
}

function CopyControls(props: CopyProps & Readonly<{ draftId: string; setup: React.RefObject<BotTemplateSetupSelectionsV1> }>) {
    const model = useNewSessionScreenModel({ draftId: props.draftId });
    const machineId = model.variant === 'simple' ? model.simpleProps.selectedMachineId ?? null : null;
    const serverId = (model.variant === 'simple' ? model.simpleProps.targetServerId : null) ?? props.execution.binding?.scope.serverId;
    const presence = useMachinePresenceSummary(serverId, machineId, props.execution.binding);
    const [setup, setSetup] = React.useState(EMPTY_BOT_TEMPLATE_SETUP);
    const [softwareValid, setSoftwareValid] = React.useState(true);
    const [installSummary, setInstallSummary] = React.useState('');
    const changeSetup = React.useCallback((value: BotTemplateSetupSelectionsV1) => {
        props.setup.current = value;
        setSetup(value);
    }, [props.setup]);
    useBotTemplateDraftCommands({ kind: 'setup', isCurrent: props.execution.isCurrent,
        read: () => ({ source: props.preview.source, expectedVersion: props.preview.release.version,
            ...(props.preview.revision ? { expectedRevision: props.preview.revision } : {}), selections: props.setup.current }),
        patch: input => {
            const parsed = BotTemplateSetupDraftPatchSchema.safeParse(input);
            if (!parsed.success) return false;
            if (parsed.data.selections !== undefined) changeSetup(parsed.data.selections);
            return true;
        },
    });
    const readiness = getBotTemplateSetupReadiness(props.preview.release.content.needs, setup);
    const petsAvailable = usePetsAvailable();
    // A Bot draft is the ordinary simple composer, including when the Account prefers the wizard.
    if (model.variant !== 'simple' || !model.botCreation || !serverId) return null;
    return <NewSessionLaunchSurface temporaryComputerLaunch={model.temporaryComputerLaunch} presentation="embedded">
        <BotTemplatePageLayout testID="bot-template-copy" content={props.preview.release.content}
            header={<BotTemplateHeader identity={props.preview.release.content.identity} pet={props.preview.release.content.pet} version={props.preview.release.version}
                presentation={props.preview.presentation} descriptionPlacement="body" />} notice={props.notice}
            footerNote={!readiness.ready || !softwareValid
                ? <Text variant="meta" style={styles.alert} accessibilityRole="alert">{t('botTemplateRecipient.setupIncomplete')}</Text>
                // A disabled Create says why: the composer's own blocker, or that it is still checking where it runs.
                : !model.simpleProps.canCreate && !model.simpleProps.isCreating
                    ? <Text variant="meta" style={styles.alert} accessibilityRole="alert" testID="bot-template-create-reason">
                        {model.simpleProps.connectionStatus?.text ?? t('botTemplates.checkingWhereItRuns')}</Text>
                    : <CopySummary botCreation={model.botCreation} software={installSummary} />}
            footer={<><RoundButton testID="bot-template-cancel" title={t('common.cancel')} display="secondary"
                disabled={model.simpleProps.isCreating} onPress={props.onCancel} />
                <RoundButton testID="bot-template-create" title={t('botTemplateRecipient.create')}
                disabled={!readiness.ready || !softwareValid || !model.simpleProps.canCreate || model.simpleProps.isCreating}
                loading={model.simpleProps.isCreating} onPress={() => { void model.simpleProps.handleCreateSession(); }} /></>}>
            <CopyIdentity preview={props.preview} botCreation={model.botCreation}
                petsAvailable={petsAvailable} petSelected={petsAvailable && setup.pet !== false} onPetSelectedChange={selected => {
                    const { pet: _pet, ...rest } = setup;
                    changeSetup(selected ? rest : { ...rest, pet: false });
                }} />
            <ItemGroup title={t('botTemplates.whereItRuns')} description={t('botTemplateRecipient.copyIntro')} surface="none">
                <NewSessionComposerCard panelProps={model.simpleProps} layout="embedded" inputPresentation="controlsOnly"
                    attachments={false} voiceAffordance="none" />
            </ItemGroup>
            <BotTemplateSetup needs={props.preview.release.content.needs} value={setup} onChange={changeSetup}
                machineId={machineId} serverId={serverId}
                machineOnline={presence.reachability === 'unknown' ? null : presence.reachability === 'reachable'}
                execution={props.execution} onValidityChange={setSoftwareValid} onInstallSummaryChange={setInstallSummary} />
            <BotTemplateWhatItDoes description={props.preview.release.content.identity.description} />
            <BotTemplatePreview content={props.preview.release.content} onDownloadFile={props.onDownloadFile} showNeeds={false} />
        </BotTemplatePageLayout>
    </NewSessionLaunchSurface>;
}

function CopySummary({ botCreation, software }: Readonly<{ botCreation: NewSessionBotCreationModel; software: string }>) {
    const name = useComposerTextValue(botCreation.nameStore);
    return <Text variant="meta" style={styles.alert}>{software ? t('botTemplateRecipient.installThenStart', { software, name })
        : t('botTemplateRecipient.startOnly', { name })}</Text>;
}

const EMPTY_FACE: SessionBotFaceV1 = Object.freeze({});

function usePetsAvailable(): boolean {
    const companion = useFeatureEnabled('pets.companion');
    const sync = useFeatureEnabled('pets.sync');
    return companion && sync;
}

/**
 * "Your copy" (lab r2 install-setup): the face and name the new Bot is born with, both the person's to change. A template
 * that carries a pet adds it as one item, on by default: while it is on the copy wears the pet, so the face shows it.
 */
function CopyIdentity({ preview, botCreation, petsAvailable, petSelected, onPetSelectedChange }: Readonly<{
    preview: BotTemplatePreviewResultV1; botCreation: NewSessionBotCreationModel;
    petsAvailable: boolean; petSelected: boolean; onPetSelectedChange: (selected: boolean) => void;
}>) {
    const name = useComposerTextValue(botCreation.nameStore);
    const face = botCreation.face ?? preview.release.content.identity.face ?? EMPTY_FACE;
    const seed = face.seed ?? preview.release.content.identity.name;
    const pet = preview.release.content.pet;
    return <ItemGroup title={t('botTemplates.yourCopy')} testID="bot-template-your-copy">
        <SectionContentRow>
            <View style={styles.copyRow}>
                {pet && petSelected
                    ? <PortablePetFace pet={pet} seed={seed} face={face} size={PAGE_HEADER_MARK_SLOT_SIZE_PX.row} testID="bot-template-copy-pet-face" />
                    : <NewBotDraftFace face={face} seed={seed} size="row" onFaceChange={botCreation.onFaceChange} />}
                <View style={styles.copyName}>
                    <FieldTextInput value={name} onChangeText={botCreation.onSessionNameChange}
                        placeholder={preview.release.content.identity.name} accessibilityLabel={t('bots.name.label')}
                        accessibilityHint={t('bots.name.hint')} testID="bot-template-copy-name" />
                </View>
            </View>
        </SectionContentRow>
        {pet ? <Item testID="bot-template-copy-pet" title={t('petShare.copyRow', { name: pet.name })}
            subtitle={!petsAvailable ? t('petShare.copyRowUnavailable') : petSelected ? t('petShare.copyRowOn') : t('petShare.copyRowOff')}
            showChevron={false} rightElement={<Switch testID="bot-template-copy-pet-switch" value={petSelected}
                disabled={!petsAvailable} onValueChange={onPetSelectedChange} />} /> : null}
    </ItemGroup>;
}

const styles = StyleSheet.create(theme => ({
    alert: { color: theme.colors.text.secondary },
    copyRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s12 },
    copyName: { flex: 1, minWidth: 0 },
}));
