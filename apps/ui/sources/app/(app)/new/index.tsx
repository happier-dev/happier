import React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeaderCloseButton } from '@/components/navigation/AppHeaderCloseButton';
import { SessionGettingStartedGuidance, useShouldBlockNewSessionWithGettingStartedGuidance } from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { NewSessionSimplePanel } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { NewSessionWizard } from '@/components/sessions/new/components/NewSessionWizard';
import { useNewSessionScreenModel } from '@/components/sessions/new/hooks/useNewSessionScreenModel';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { NewSessionScreenPortalScope } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';
import { parseCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { resolveNewSessionDraftRouteIdentity } from '@/components/sessions/new/navigation/newSessionDraftRouteIdentity';
import { useResolveNewSessionOrdinaryEntryRoute } from '@/components/sessions/new/navigation/newSessionOrdinaryEntryRoute';
import {
    SessionDraftConflictResolution,
    useSessionDraftConflictComposerBanner,
} from '@/components/sessions/drafts/SessionDraftConflictResolution';
import { ComposerBannerCollapseProvider } from '@/components/sessions/composerBanners/ComposerBannerCollapseProvider';
import { ComposerAuxiliaryFrame } from '@/components/sessions/shell/view/ComposerAuxiliaryFrame';
import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import {
    deleteSessionDraft,
    setOrdinaryEntryDraftId,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { useNewSessionDraftHostSnapshot } from '@/components/sessions/drafts/useNewSessionDraftProjection';
import { useAllActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import { resolvePersistedNewSessionOperationIdentity } from '@/sync/domains/actionOperations/actionOperationReentry';
import { NewSessionDraftComposerActions } from '@/components/sessions/drafts/NewSessionDraftComposerActions';
import { Modal } from '@/modal';
import { t } from '@/text';

const WEB_CLOSE_BUTTON_EDGE_INSET = 8;

function NewSessionWebCloseFallback() {
    const router = useRouter();
    const { width: windowWidth } = useWindowDimensions();

    if (Platform.OS !== 'web' || !isMobileLayoutWidth(windowWidth)) {
        return null;
    }

    return (
        <View pointerEvents="box-none" style={styles.webCloseButton}>
            <AppHeaderCloseButton testID="new-session-cancel" onPress={() => safeRouterBack({ router, fallbackHref: '/' })} />
        </View>
    );
}

function NewSessionScreenInner(props: Readonly<{
    composerTopContent?: React.ReactNode;
    draftId: string;
    statusBadges?: ReadonlyArray<AgentInputStatusBadge>;
    statusTrailingActions?: React.ReactNode;
}>) {
    const model = useNewSessionScreenModel({ draftId: props.draftId });

    if (model.variant === 'simple') {
        return (
            <NewSessionSimplePanel
                {...model.simpleProps}
                composerTopContent={props.composerTopContent}
                statusBadges={props.statusBadges}
                statusTrailingActions={props.statusTrailingActions}
            />
        );
    }

    const { layout, sectionPresentation, profiles, agent, machine, footer } = model.wizardProps;

    return (
        <NewSessionWizard
            popoverBoundaryRef={model.popoverBoundaryRef}
            layout={layout}
            sectionPresentation={sectionPresentation}
            profiles={profiles}
            agent={agent}
            machine={machine}
            footer={footer}
            composerTopContent={props.composerTopContent}
            statusBadges={props.statusBadges}
            statusTrailingActions={props.statusTrailingActions}
        />
    );
}

function NewSessionContent(props: Readonly<{
    allowBlockingGuidance: boolean;
    composerTopContent?: React.ReactNode;
    draftId: string;
    statusBadges?: ReadonlyArray<AgentInputStatusBadge>;
    statusTrailingActions?: React.ReactNode;
}>) {
    const shouldBlock = useShouldBlockNewSessionWithGettingStartedGuidance();

    if (props.allowBlockingGuidance && shouldBlock) {
        return (
            <>
                <NewSessionWebCloseFallback />
                <SessionGettingStartedGuidance variant="newSessionBlocking" />
            </>
        );
    }

    return (
        <NewSessionScreenPortalScope>
            <NewSessionWebCloseFallback />
            <NewSessionScreenInner {...props} />
        </NewSessionScreenPortalScope>
    );
}

function NewSessionScreenForDraft(props: Readonly<{ draftId: string }>) {
    const router = useRouter();
    const resolveOrdinaryEntryRoute = useResolveNewSessionOrdinaryEntryRoute();
    const { dataId, machineId, directory, draftOrigin } = useLocalSearchParams<{
        dataId?: string;
        spawnServerId?: string;
        machineId?: string;
        directory?: string;
        draftOrigin?: string;
    }>();
    const draftScope = useActiveServerAccountScope();
    const draftAddress = React.useMemo(() => ({ kind: 'newSession', draftId: props.draftId } as const), [props.draftId]);
    const draftSnapshot = useNewSessionDraftHostSnapshot(draftScope, props.draftId);
    React.useEffect(() => {
        if (draftOrigin !== 'ordinary' || !draftScope || draftSnapshot?.materialized !== true) return;
        setOrdinaryEntryDraftId(draftScope, props.draftId);
    }, [draftOrigin, draftScope, draftSnapshot?.materialized, props.draftId]);
    const actionOperations = useAllActionOperations(draftScope?.accountId ?? '');
    const hasUnresolvedLaunch = React.useMemo(() => Boolean(draftScope && draftSnapshot && (
        resolvePersistedNewSessionOperationIdentity({
            draftScope,
            draftId: props.draftId,
            draft: draftSnapshot.localSupplement,
            operations: actionOperations,
        })
    )), [actionOperations, draftScope, draftSnapshot]);
    const startAnother = React.useCallback(() => {
        const next = resolveOrdinaryEntryRoute({ forceFresh: true });
        router.replace({
            pathname: '/new',
            params: { draftId: next.draftId, draftOrigin: next.draftOrigin },
        });
    }, [resolveOrdinaryEntryRoute, router]);
    const deleteDraft = React.useCallback(async () => {
        if (!draftScope || hasUnresolvedLaunch) return;
        const confirmed = await Modal.confirm(
            t('sessionDrafts.delete.confirmTitle'),
            t('sessionDrafts.delete.confirmDescription'),
            {
                confirmText: t('common.delete'),
                cancelText: t('common.cancel'),
                destructive: true,
            },
        );
        if (!confirmed) return;
        await deleteSessionDraft({ scope: draftScope, address: draftAddress });
        const next = resolveOrdinaryEntryRoute({ forceFresh: true });
        router.replace({
            pathname: '/new',
            params: { draftId: next.draftId, draftOrigin: next.draftOrigin },
        });
    }, [draftAddress, draftScope, hasUnresolvedLaunch, resolveOrdinaryEntryRoute, router]);

    const tempData = React.useMemo(() => {
        return typeof dataId === 'string' ? peekTempData<NewSessionData>(dataId) : null;
    }, [dataId]);

    const hasSeededDraftIntent = React.useMemo(() => {
        if (draftSnapshot?.materialized) return true;
        if (parseCheckoutCreationDraft(tempData?.checkoutCreationDraft)) return true;
        if (draftSnapshot?.document.target.kind !== 'newSession') return false;
        const authoring = draftSnapshot.document.target.authoring as Readonly<Record<string, Readonly<{ value: unknown }>>>;
        return parseCheckoutCreationDraft(
            authoring.checkoutCreationDraft?.value,
        ) !== null;
    }, [draftSnapshot, tempData?.checkoutCreationDraft]);

    const hasSeededRouteIntent = React.useMemo(() => {
        return (
            (typeof machineId === 'string' && machineId.trim().length > 0)
            || (typeof directory === 'string' && directory.trim().length > 0)
            || (typeof tempData?.machineId === 'string' && tempData.machineId.trim().length > 0)
            || (typeof tempData?.directory === 'string' && tempData.directory.trim().length > 0)
            || (typeof tempData?.path === 'string' && tempData.path.trim().length > 0)
        );
    }, [machineId, directory, tempData]);

    const draftConflictBanner = useSessionDraftConflictComposerBanner(draftSnapshot?.conflict ?? null);
    const composerTopContent = draftScope && draftSnapshot?.materialized && draftSnapshot.conflict && !draftConflictBanner.collapsed ? (
        <ComposerAuxiliaryFrame>
            <SessionDraftConflictResolution
                scope={draftScope}
                address={draftAddress}
                conflict={draftSnapshot.conflict}
            />
        </ComposerAuxiliaryFrame>
    ) : null;
    const statusBadges = draftConflictBanner.statusBadge ? [draftConflictBanner.statusBadge] : undefined;
    const statusTrailingActions = draftScope && draftSnapshot?.materialized ? (
        <NewSessionDraftComposerActions
            deleteDisabled={hasUnresolvedLaunch}
            onStartAnother={startAnother}
            onDelete={deleteDraft}
        />
    ) : null;
    return (
        <NewSessionContent
            allowBlockingGuidance={!hasSeededDraftIntent && !hasSeededRouteIntent}
            draftId={props.draftId}
            composerTopContent={composerTopContent}
            statusBadges={statusBadges}
            statusTrailingActions={statusTrailingActions}
        />
    );
}

function NewSessionScreen() {
    const router = useRouter();
    const resolveOrdinaryEntryRoute = useResolveNewSessionOrdinaryEntryRoute();
    const { draftId: routeDraftId, draftOrigin: routeDraftOrigin } = useLocalSearchParams<{
        draftId?: string | string[];
        draftOrigin?: string;
    }>();
    const generatedDraftIdRef = React.useRef<string | null>(null);
    const identity = React.useMemo(() => {
        const createDraftId = () => {
            generatedDraftIdRef.current ??= resolveNewSessionDraftRouteIdentity({ routeDraftId: undefined }).draftId;
            return generatedDraftIdRef.current;
        };
        if (routeDraftId === undefined) {
            const ordinary = resolveOrdinaryEntryRoute({ createDraftId });
            return {
                draftId: ordinary.draftId,
                draftOrigin: ordinary.draftOrigin,
                shouldWriteRouteParam: true,
            } as const;
        }
        const explicit = resolveNewSessionDraftRouteIdentity({ routeDraftId, createDraftId });
        return {
            ...explicit,
            draftOrigin: routeDraftOrigin === 'ordinary' ? 'ordinary' as const : null,
        };
    }, [resolveOrdinaryEntryRoute, routeDraftId, routeDraftOrigin]);

    React.useEffect(() => {
        if (identity.shouldWriteRouteParam) {
            router.setParams({
                draftId: identity.draftId,
                ...(identity.draftOrigin ? { draftOrigin: identity.draftOrigin } : {}),
            });
        }
    }, [identity, router]);

    return (
        <ComposerBannerCollapseProvider key={identity.draftId}>
            <NewSessionScreenForDraft draftId={identity.draftId} />
        </ComposerBannerCollapseProvider>
    );
}

export default React.memo(NewSessionScreen);

const styles = StyleSheet.create({
    webCloseButton: {
        position: 'absolute',
        top: WEB_CLOSE_BUTTON_EDGE_INSET,
        right: WEB_CLOSE_BUTTON_EDGE_INSET,
        zIndex: 20,
    },
});
