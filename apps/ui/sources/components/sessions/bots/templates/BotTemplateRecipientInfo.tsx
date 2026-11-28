import * as React from 'react';
import type { BotTemplateInstanceV1, BotTemplateSourceSessionRefV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { isBundledBotTemplateSource } from '@happier-dev/plugins-bot-templates/catalog';
import { BotTemplateFollowResultV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { t } from '@/text';
import { buildBotTemplateRecipientRoute } from './botTemplateRecipientDestination';
import { useBotTemplateFollowOffer, type BotTemplateFollowOffer } from './useBotTemplateFollowOffer';

const PluginFollowOffer = React.lazy(() => import('./BotTemplatePluginFollowOffer'));

export type BotTemplateRecipientInfoPresentation = Readonly<{
    name: string | null;
    author: string | null;
    availableVersion: string | null;
    review: () => void;
    details: React.ReactNode;
}>;

export function BotTemplateRecipientInfo({ instance: suppliedInstance, serverId, sessionRef, renderTemplate }: Readonly<{
    instance: BotTemplateInstanceV1; serverId: string; sessionRef: BotTemplateSourceSessionRefV1;
    renderTemplate?: (facts: BotTemplateRecipientInfoPresentation) => React.ReactNode;
}>) {
    const router = useRouter();
    const key = JSON.stringify([sessionRef, suppliedInstance]);
    const [settled, setSettled] = React.useState<Readonly<{ key: string; instance: BotTemplateInstanceV1 }> | null>(null);
    const instance = settled?.key === key ? settled.instance : suppliedInstance;
    const offer = useBotTemplateFollowOffer(instance);
    const review = () => router.pushRetainingCurrent(buildBotTemplateRecipientRoute(instance.source, serverId, sessionRef) as Href);
    const present = (current: BotTemplateFollowOffer | null) => {
        const availableVersion = instance.follow && current?.offer === 'available' ? current.version : null;
        const details = <>
        <Item testID="bot-template-source" title={t('botTemplateRecipient.source')}
            onPress={() => router.pushRetainingCurrent(buildBotTemplateRecipientRoute(instance.source, serverId) as Href)} />
        <Item testID="bot-template-accepted-preview" title={t('botTemplateRecipient.acceptedVersion', { version: instance.acceptedVersion })}
            onPress={() => router.pushRetainingCurrent(buildBotTemplateRecipientRoute({ kind: 'artifact', ...instance.acceptedBase }, serverId) as Href)} />
        <Item title={t('botTemplateRecipient.follow')} subtitle={instance.follow ? undefined : t('botTemplateRecipient.independentCopy')}
            detail={t(instance.follow ? 'common.on' : 'common.off')} mode="info" showChevron={false} />
        {instance.follow && current?.offer !== 'current' && current?.offer !== 'skipped' && (!renderTemplate || !availableVersion)
            ? <Item testID="bot-template-review-updates"
                title={t(availableVersion ? 'botTemplateRecipient.updatesTitle' : 'botTemplateRecipient.reviewUpdates')}
                onPress={review} /> : null}
        {instance.follow ? <StopFollowing sessionRef={sessionRef} onStopped={instance => setSettled({ key, instance })} /> : null}
        </>;
        return renderTemplate ? renderTemplate({ name: current?.name ?? null, author: current?.author ?? null, availableVersion, review, details }) : details;
    };
    return instance.follow && instance.source.kind === 'plugin' && !isBundledBotTemplateSource(instance.source)
        ? <React.Suspense fallback={present(null)}><PluginFollowOffer instance={{ ...instance, source: instance.source }} serverId={serverId}>
            {present}</PluginFollowOffer></React.Suspense> : present(offer);
}

/** Stopping uses only the recipient's private instance, so an unavailable source cannot hide recovery. */
function StopFollowing(props: Readonly<{ sessionRef: BotTemplateSourceSessionRefV1; onStopped: (instance: BotTemplateInstanceV1) => void }>) {
    const execution = useMountedActionExecution(props.sessionRef.serverId);
    const [busy, setBusy] = React.useState(false);
    const [errorCode, setErrorCode] = React.useState<string | null>(null);
    const stop = async () => {
        setBusy(true); setErrorCode(null);
        try {
            const result = await execution.execute('template.follow.stop', { sessionRef: props.sessionRef }, { confirmed: true });
            if (!execution.isCurrent()) return;
            const parsed = result.ok ? BotTemplateFollowResultV1Schema.safeParse(result.result) : null;
            if (parsed?.success) props.onStopped(parsed.data.instance);
            else setErrorCode(result.ok ? 'invalid_result' : result.errorCode ?? 'template_update_unavailable');
        } catch (error) {
            if (execution.isCurrent()) setErrorCode(readUnexpectedActionErrorDiagnosticV1(error).errorCode ?? 'unexpected_error');
        } finally { if (execution.isCurrent()) setBusy(false); }
    };
    return <>
        {errorCode ? <SurfaceStateCard kind="error" title={t('botTemplates.unavailable')} diagnosticCode={errorCode} /> : null}
        <Item testID="bot-template-info-stop-following" title={t('botTemplateRecipient.stopFollowing')}
            disabled={busy || !execution.ready} onPress={() => { void stop(); }} showChevron={false} />
    </>;
}
