import * as React from 'react';
import { Platform } from 'react-native';
import type { ArtifactSignedInLinkOpenedV1 } from '@happier-dev/protocol/actions/executor/artifactPublicLinkActions';
import { getArtifactUseTargetV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { resolveArtifactOpenRoute } from '@/components/artifacts/artifactBrowserModel';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureArtifactSignedInLinkSecret, takeNativeArtifactSignedInLinkSecret } from '@/utils/url/artifactSignedInLinkSecret';
import { describeBotTemplateOpenRefusal, readBotTemplateOpenRefusal, type BotTemplateOpenRefusal } from '@/components/sessions/bots/templates/botTemplateOpenRefusal';
import { t } from '@/text';

const Recipient = React.lazy(() => import('@/components/sessions/bots/templates/BotTemplateRecipientScreen')
    .then(module => ({ default: module.BotTemplateRecipientScreen })));

/** The link's key and opened release remain with this mounted surface. */
export function ArtifactSignedInLinkScreen(props: Readonly<{ lookupId: string; serverId?: string }>) {
    const activeScope = useActiveServerAccountScope();
    const router = useRouter();
    const execution = useMountedActionExecution(props.serverId ?? activeScope?.serverId);
    const [secret] = React.useState(() => {
        if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.hash) {
            return captureArtifactSignedInLinkSecret({ lookupId: props.lookupId, url: window.location.href,
                replaceUrl: path => window.history.replaceState(window.history.state, '', path) });
        }
        return takeNativeArtifactSignedInLinkSecret(props.lookupId);
    });
    const secretMounted = React.useRef(false);
    React.useEffect(() => {
        secretMounted.current = true;
        return () => {
            secretMounted.current = false;
            // React replays effects on the same mounted surface in development.
            // Retire custody only after that synchronous replay can reclaim it.
            queueMicrotask(() => { if (!secretMounted.current) secret?.dispose(); });
        };
    }, [secret]);
    const [opened, setOpened] = React.useState<Readonly<{
        value: ArtifactSignedInLinkOpenedV1;
        binding: ServerCredentialAccountScopeBinding;
    }> | null>(null);
    const [pending, setPending] = React.useState(false);
    const [failure, setFailure] = React.useState<'reopen' | BotTemplateOpenRefusal | null>(null);
    const openedCurrent = Boolean(opened && opened.binding === execution.binding && execution.isCurrent());
    React.useEffect(() => {
        if (!opened) return;
        const discardOpened = () => { setOpened(null); setFailure('reopen'); };
        if (!openedCurrent) { discardOpened(); return; }
        const retirement = opened.binding.onRetire(discardOpened);
        return () => retirement.dispose();
    }, [opened, openedCurrent]);
    const open = async () => {
        if (!execution.ready || !secret || pending || failure) return;
        setPending(true);
        try {
            const result = await execution.execute('artifact.public_link.join', { lookupId: props.lookupId }, { confirmed: true,
                executorOptions: { consumeArtifactSignedInLinkSecret: secret.consumeSecret,
                    onArtifactSignedInLinkOpened: value => {
                        if (!execution.isCurrent() || !execution.binding) return;
                        if (getArtifactUseTargetV1(value.artifact, 'signed_in').kind === 'bot_template') {
                            setOpened({ value, binding: execution.binding });
                        }
                        else router.replace(resolveArtifactOpenRoute({ id: value.artifact.artifactId,
                            header: value.artifact.header, rawHeader: value.artifact.header,
                            sourceServerId: execution.binding.scope.serverId }) as never);
                    } } });
            if (!result.ok && execution.isCurrent()) {
                setFailure(readBotTemplateOpenRefusal(result) ?? 'reopen');
            }
        } catch { if (execution.isCurrent()) setFailure('reopen'); }
        finally { if (execution.isCurrent()) setPending(false); }
    };
    if (opened && openedCurrent) return <React.Suspense fallback={<SurfaceStateCard kind="loading" title={t('common.loading')} />}>
        <Recipient source={{ kind: 'artifact', serverId: opened.binding.scope.serverId, artifactId: opened.value.source.artifactId }}
            serverId={opened.binding.scope.serverId} />
    </React.Suspense>;
    const openingFailure = opened && !openedCurrent ? 'reopen' : failure;
    return <ItemList>
        <SurfaceStateCard kind={openingFailure || !secret ? 'error' : 'empty'} title={t('botTemplates.signedInLink')}
            reason={openingFailure && openingFailure !== 'reopen' ? describeBotTemplateOpenRefusal(openingFailure)
                : openingFailure || !secret ? t('botTemplates.reopenLink') : !execution.ready
                ? t('botTemplates.signInRequired') : t('botTemplates.signedInLinkDescription')} />
        {secret && !openingFailure ? <RoundButton testID="artifact-signed-in-link-open" title={t('common.open')}
            loading={pending} disabled={!execution.ready || pending} onPress={() => { void open(); }} /> : null}
    </ItemList>;
}
