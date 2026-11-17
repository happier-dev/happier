import * as React from 'react';
import { v5 as uuidv5 } from 'uuid';
import type { BotTemplateReleaseSourceV1, BotTemplateSourceSessionRefV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { BotTemplateExportFileResultV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { NavigationBackChromeProvider, useNavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';
import { usePhoneDestinationBack } from '@/components/ui/layout/usePageBackControl';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { saveFileBytes } from '@/sync/runtime/files/saveFileBytes';
import { openSessionAuthoringSeed } from '@/sync/ops/actions/openSessionAuthoringSeed';
import { NEW_BOT_SEED } from '@/components/sessions/bots/newBotDraft';
import { resolveAgentExecutionTargetForPersistedSelection } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';
import { getSessionDraftSnapshot } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { NewSessionHostParams } from '@/components/sessions/new/navigation/newSessionHost';
import { BotTemplateHeader } from './BotTemplateHeader';
import { BotTemplatePreview } from './BotTemplatePreview';
import { BotTemplatePageLayout, BotTemplateWhatItDoes } from './BotTemplatePageLayout';
import { useBotTemplateRecipient } from './useBotTemplateRecipient';
import { describeBotTemplateOpenRefusal } from './botTemplateOpenRefusal';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

// Machine/Agent selection mounts only after the person asks to make a copy.
const CopyForm = React.lazy(() => import('./BotTemplateCopyForm'));
const UpdateReview = React.lazy(() => import('./BotTemplateUpdateReview').then(module => ({ default: module.BotTemplateUpdateReview })));

export function BotTemplateRecipientScreen(props: Readonly<{ source: BotTemplateReleaseSourceV1; serverId: string; sessionRef?: BotTemplateSourceSessionRefV1 }>) {
    // A phone has no tab bar route back from a template page (preview, setup, What's new): its header carries Back,
    // and a direct load with no history goes Home.
    const inheritedBack = useNavigationBackControl();
    const phoneBack = usePhoneDestinationBack('bot-template:back');
    const home = props.source.kind === 'artifact' ? props.source.serverId : props.serverId;
    return <NavigationBackChromeProvider control={phoneBack ?? inheritedBack}>
        {props.sessionRef ? <React.Suspense fallback={<SurfaceStateCard kind="loading" title={t('common.loading')} />}>
            <UpdateReview key={JSON.stringify(props.sessionRef)} sessionRef={props.sessionRef} />
        </React.Suspense> : <Recipient key={JSON.stringify([home, props.source])} {...props} serverId={home} />}
    </NavigationBackChromeProvider>;
}

function Recipient({ source, serverId }: Readonly<{ source: BotTemplateReleaseSourceV1; serverId: string }>) {
    const reader = useBotTemplateRecipient(source, serverId);
    return <BotTemplateRecipientBody key={JSON.stringify([reader.execution.binding?.scope, reader.execution.binding?.revision])}
        reader={reader} source={source} serverId={serverId} />;
}

/** The previewed release; the dev specimen renders it with seed data. */
export function BotTemplateRecipientBody({ reader, source, serverId }: Readonly<{ reader: ReturnType<typeof useBotTemplateRecipient>;
    source: BotTemplateReleaseSourceV1; serverId: string }>) {
    const { preview, execution } = reader;
    const phone = useDeviceType() === 'phone';
    const [draftParams, setDraftParams] = React.useState<NewSessionHostParams | null>(null);
    const [editing, setEditing] = React.useState(false);
    const [changed, setChanged] = React.useState(false);
    const [refreshing, setRefreshing] = React.useState(false);
    const reloadChanged = React.useCallback(async () => {
        setEditing(false);
        setChanged(true);
        setRefreshing(true);
        try { await reader.reload(); } finally { if (execution.isCurrent()) setRefreshing(false); }
    }, [reader.reload, execution.isCurrent]);
    const download = React.useCallback(async (skillKey: string, path: string) => {
        try {
            const file = BotTemplateExportFileResultV1Schema.parse(await execution.executeValue('template.export_file', { source, skillKey, path }));
            await saveFileBytes({ fileName: file.fileName, mimeType: file.contentKind === 'utf8' ? 'text/plain' : 'application/octet-stream',
                bytes: decodeBase64(file.contentBase64), isCurrent: execution.isCurrent });
        } catch { if (execution.isCurrent()) await Modal.alert(t('common.error'), t('botTemplates.unavailable')); }
    }, [source, execution.executeValue, execution.isCurrent]);
    const makeOwn = React.useCallback(async () => {
        if (!preview || !execution.binding) return;
        if (draftParams) { setEditing(true); return; }
        const draftId = uuidv5(JSON.stringify(['happier.bot-template-copy-draft.v1', source]), uuidv5.URL);
        const openDraft = (entry: Readonly<{ draftId: string }>) => {
            setDraftParams({ draftId: entry.draftId, draftServerId: execution.binding!.scope.serverId,
                draftAccountId: execution.binding!.scope.accountId, spawnServerId: serverId });
            setEditing(true);
        };
        // The repository keeps edits and launch custody; successful creation clears this draft.
        if (getSessionDraftSnapshot(execution.binding.scope, { kind: 'newSession', draftId })?.materialized) {
            openDraft({ draftId });
            return;
        }
        // The template's suggested Agent is the copy's starting choice; the composer still says when it isn't ready here.
        const suggested = preview.release.content.suggestedAgent;
        const agentTarget = suggested ? resolveAgentExecutionTargetForPersistedSelection({ backendTarget: null, fallbackAgentId: suggested.agentId }) : null;
        await openSessionAuthoringSeed({
            seed: { ...NEW_BOT_SEED, sessionName: preview.release.content.identity.name, ...(agentTarget ? { agentTarget } : {}),
                initialSessionFacts: { ...NEW_BOT_SEED.initialSessionFacts,
                    ...(preview.release.content.identity.face ? { botFace: preview.release.content.identity.face } : {}) } },
            scope: execution.binding.scope, signal: execution.getSignal(), isCurrent: execution.isCurrent,
            accountLifetime: execution.binding,
            createDraftId: () => draftId,
            navigateToNewSession: openDraft,
        });
    }, [preview, source, draftParams, execution.binding, execution.getSignal, execution.isCurrent, serverId]);
    // A refusal (deleted, no longer shared, needs an encrypted Account) says why and offers no retry that can't succeed.
    const failure = reader.failed ? <SurfaceStateCard testID="bot-template-recipient-load" kind={reader.refusal ? 'unavailable' : 'error'} iconName={reader.refusal ? 'lock' : undefined}
        title={t('botTemplates.unavailable')} reason={reader.refusal ? describeBotTemplateOpenRefusal(reader.refusal) : undefined}
        action={reader.refusal ? undefined : { label: t('common.retry'), onPress: reader.reload }} /> : null;
    if (!preview) return failure ?? <SurfaceStateCard testID="bot-template-recipient-load" kind="loading" title={t('common.loading')} />;
    const notice = <>
        {changed ? <AttentionBanner testID="bot-template-release-changed" tone="warning" title={t('botTemplateRecipient.releaseChanged')} /> : null}
    </>;
    if (editing && draftParams && execution.binding) return <React.Suspense fallback={<SurfaceStateCard kind="loading" title={t('common.loading')} />}>
        <CopyForm preview={preview} execution={execution} params={draftParams} setParams={setDraftParams}
            onVersionChanged={reloadChanged} onHandedOff={() => { setDraftParams(null); setEditing(false); }}
            onCancel={() => setEditing(false)}
            onDownloadFile={(skillKey, path) => { void download(skillKey, path); }} notice={notice} />
    </React.Suspense>;
    // One primary: beside the identity on wide layouts, pinned full width under the scroll on a phone.
    const makeOwnButton = <RoundButton testID="bot-template-make-own" title={t('botTemplates.makeOwnEllipsis')}
        disabled={!execution.ready || refreshing || reader.failed} onPress={makeOwn} />;
    return <BotTemplatePageLayout testID="bot-template-recipient" content={preview.release.content}
        footer={phone ? makeOwnButton : undefined}
        header={<BotTemplateHeader identity={preview.release.content.identity} version={preview.release.version}
            presentation={preview.presentation} descriptionPlacement="body"
            actions={phone ? undefined : makeOwnButton} />}
        notice={<>
            {notice}
            {failure}
        </>}>
        <BotTemplateWhatItDoes description={preview.release.content.identity.description} />
        <BotTemplatePreview content={preview.release.content} onDownloadFile={(skillKey, path) => { void download(skillKey, path); }} />
    </BotTemplatePageLayout>;
}
