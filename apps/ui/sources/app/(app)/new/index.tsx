import React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { SessionGettingStartedGuidance } from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { useShouldBlockNewSessionWithGettingStartedGuidance } from '@/components/sessions/guidance/useShouldBlockNewSessionWithGettingStartedGuidance';
import { NewSessionSimplePanel } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { NewSessionWizard } from '@/components/sessions/new/components/NewSessionWizard';
import { useNewSessionScreenModel } from '@/components/sessions/new/hooks/useNewSessionScreenModel';
import { NewSessionScreenPortalScope } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';
import { resolveNewSessionDraftRouteIdentity } from '@/components/sessions/new/navigation/newSessionDraftRouteIdentity';
import { useResolveNewSessionOrdinaryEntryRoute } from '@/components/sessions/new/navigation/newSessionOrdinaryEntryRoute';
import { isNewSessionDraftLaunchInCustody } from '@/components/sessions/new/modules/newSessionDraftLaunchCustody';
import { NewSessionDraftComposerActions } from '@/components/sessions/drafts/NewSessionDraftComposerActions';
import {
    SessionDraftConflictResolution,
    useSessionDraftConflictComposerBanner,
} from '@/components/sessions/drafts/SessionDraftConflictResolution';
import { ComposerBannerCollapseProvider } from '@/components/sessions/composerBanners/ComposerBannerCollapseProvider';
import { ComposerAuxiliaryFrame } from '@/components/sessions/shell/view/ComposerAuxiliaryFrame';
import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { Modal } from '@/modal';
import { useAllActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import { parseNewSessionCheckoutDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import {
    clearNewSessionOrdinaryEntryDraftIdExact,
    setNewSessionOrdinaryEntryDraftId,
} from '@/sync/domains/settings/localOnlyAccountSettings';
import { useActiveServerAccountScope, useSettingMutable } from '@/sync/store/hooks';
import {
    getSessionDraftSnapshot,
    subscribeSessionDraft,
    deleteSessionDraft,
    type SessionDraftSnapshot,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { t } from '@/text';

function hasSeededCheckoutIntent(value: unknown): boolean {
    const draft = parseNewSessionCheckoutDraft(value);
    return draft.checkoutCreationDraft !== null;
}

function NewSessionScreenInner(props: Readonly<{
    composerTopContent?: React.ReactNode;
    draftId: string;
    statusBadges?: ReadonlyArray<AgentInputStatusBadge>;
    statusTrailingActions?: React.ReactNode;
}>) {
    const model = useNewSessionScreenModel(props);

    if (model.variant === 'simple') {
        return <NewSessionSimplePanel {...model.simpleProps} />;
    }

    const { layout, profiles, agent, machine, footer } = model.wizardProps;

    return (
        <NewSessionWizard
            popoverBoundaryRef={model.popoverBoundaryRef}
            layout={layout}
            profiles={profiles}
            agent={agent}
            machine={machine}
            footer={footer}
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
        return <SessionGettingStartedGuidance variant="newSessionBlocking" />;
    }

    return (
        <NewSessionScreenPortalScope>
            <NewSessionScreenInner {...props} />
        </NewSessionScreenPortalScope>
    );
}

function NewSessionScreen() {
    const router = useRouter();
    const { dataId, draftId: routeDraftId, draftOrigin, machineId, directory } = useLocalSearchParams<{
        dataId?: string;
        draftId?: string;
        draftOrigin?: string;
        spawnServerId?: string;
        machineId?: string;
        directory?: string;
    }>();
    const draftScope = useActiveServerAccountScope();
    const resolveOrdinaryEntry = useResolveNewSessionOrdinaryEntryRoute();
    const [ordinaryEntryDraftId, setOrdinaryEntryDraftId] = useSettingMutable('newSessionOrdinaryEntryDraftId');
    const draftIdentity = React.useMemo(() => {
        const explicitIdentity = resolveNewSessionDraftRouteIdentity({ routeDraftId });
        if (!explicitIdentity.shouldWriteRouteParam) {
            return {
                draftId: explicitIdentity.draftId,
                draftOrigin: draftOrigin === 'ordinary' ? 'ordinary' as const : null,
                shouldWriteRouteParam: false,
            };
        }
        const ordinaryEntry = resolveOrdinaryEntry();
        return {
            draftId: ordinaryEntry.draftId,
            draftOrigin: ordinaryEntry.draftOrigin,
            shouldWriteRouteParam: true,
        };
    }, [draftOrigin, resolveOrdinaryEntry, routeDraftId]);
    React.useEffect(() => {
        if (!draftIdentity.shouldWriteRouteParam) return;
        router.setParams({ draftId: draftIdentity.draftId, draftOrigin: draftIdentity.draftOrigin ?? undefined });
    }, [draftIdentity.draftId, draftIdentity.draftOrigin, draftIdentity.shouldWriteRouteParam, router]);
    const draftAddress = React.useMemo(() => ({
        kind: 'newSession' as const,
        draftId: draftIdentity.draftId,
    }), [draftIdentity.draftId]);
    const subscribeDraft = React.useCallback((listener: () => void) => (
        draftScope ? subscribeSessionDraft(draftScope, draftAddress, listener) : () => undefined
    ), [draftAddress, draftScope]);
    const getDraftSnapshot = React.useCallback((): SessionDraftSnapshot | null => (
        draftScope ? getSessionDraftSnapshot(draftScope, draftAddress) : null
    ), [draftAddress, draftScope]);
    const exactDraft = React.useSyncExternalStore(subscribeDraft, getDraftSnapshot, getDraftSnapshot);
    React.useEffect(() => {
        if (draftIdentity.draftOrigin !== 'ordinary' || exactDraft?.materialized !== true) return;
        const pointerDelta = setNewSessionOrdinaryEntryDraftId(draftIdentity.draftId);
        if (pointerDelta && pointerDelta.newSessionOrdinaryEntryDraftId !== ordinaryEntryDraftId) {
            setOrdinaryEntryDraftId(pointerDelta.newSessionOrdinaryEntryDraftId);
        }
    }, [draftIdentity.draftId, draftIdentity.draftOrigin, exactDraft?.materialized, ordinaryEntryDraftId, setOrdinaryEntryDraftId]);
    const actionOperations = useAllActionOperations();
    const launchInCustody = Boolean(draftScope && exactDraft && isNewSessionDraftLaunchInCustody({
        accountId: draftScope.accountId,
        launchUserAttemptId: exactDraft.localSupplement.launchUserAttemptId,
        operations: actionOperations,
    }));
    const startAnother = React.useCallback(() => {
        const nextEntry = resolveOrdinaryEntry({ forceFresh: true });
        router.push({ pathname: '/new', params: {
            draftId: nextEntry.draftId,
            draftOrigin: nextEntry.draftOrigin,
        } });
    }, [resolveOrdinaryEntry, router]);
    const deleteDraft = React.useCallback(async () => {
        if (!draftScope || launchInCustody) return;
        const confirmed = await Modal.confirm(
            t('sessionDrafts.delete.confirmTitle'),
            t('sessionDrafts.delete.confirmDescription'),
            { confirmText: t('common.delete'), cancelText: t('common.cancel'), destructive: true },
        );
        if (!confirmed) return;
        await deleteSessionDraft({ scope: draftScope, address: draftAddress });
        const pointerDelta = clearNewSessionOrdinaryEntryDraftIdExact(
            { newSessionOrdinaryEntryDraftId: ordinaryEntryDraftId },
            draftIdentity.draftId,
        );
        if (pointerDelta) setOrdinaryEntryDraftId(pointerDelta.newSessionOrdinaryEntryDraftId);
        const nextEntry = resolveOrdinaryEntry({ forceFresh: true });
        router.replace({ pathname: '/new', params: {
            draftId: nextEntry.draftId,
            draftOrigin: nextEntry.draftOrigin,
        } });
    }, [draftAddress, draftIdentity.draftId, draftScope, launchInCustody, ordinaryEntryDraftId, resolveOrdinaryEntry, router, setOrdinaryEntryDraftId]);

    const tempData = React.useMemo(() => {
        return typeof dataId === 'string' ? peekTempData<NewSessionData>(dataId) : null;
    }, [dataId]);

    const hasSeededDraftIntent = React.useMemo(() => {
        if (exactDraft?.materialized === true) return true;
        return hasSeededCheckoutIntent({ checkoutCreationDraft: tempData?.checkoutCreationDraft ?? null });
    }, [exactDraft?.materialized, tempData?.checkoutCreationDraft]);

    const hasSeededRouteIntent = React.useMemo(() => {
        return (
            (typeof machineId === 'string' && machineId.trim().length > 0)
            || (typeof directory === 'string' && directory.trim().length > 0)
            || (typeof tempData?.machineId === 'string' && tempData.machineId.trim().length > 0)
            || (typeof tempData?.directory === 'string' && tempData.directory.trim().length > 0)
            || (typeof tempData?.path === 'string' && tempData.path.trim().length > 0)
        );
    }, [machineId, directory, tempData]);

    const draftConflictBanner = useSessionDraftConflictComposerBanner(exactDraft?.conflict ?? null);
    const composerTopContent = React.useMemo(() => (
        draftScope && exactDraft?.materialized === true && exactDraft.conflict && !draftConflictBanner.collapsed ? (
            <ComposerAuxiliaryFrame>
                <SessionDraftConflictResolution
                    scope={draftScope}
                    address={draftAddress}
                    conflict={exactDraft.conflict}
                />
            </ComposerAuxiliaryFrame>
        ) : null
    ), [draftAddress, draftConflictBanner.collapsed, draftScope, exactDraft?.conflict, exactDraft?.materialized]);
    const statusBadges = draftConflictBanner.statusBadge ? [draftConflictBanner.statusBadge] : undefined;
    const statusTrailingActions = React.useMemo(() => (
        draftScope && exactDraft?.materialized === true ? (
            <NewSessionDraftComposerActions
                deleteDisabled={launchInCustody}
                onStartAnother={startAnother}
                onDelete={deleteDraft}
            />
        ) : null
    ), [deleteDraft, draftScope, exactDraft?.materialized, launchInCustody, startAnother]);

    return (
        <NewSessionContent
            allowBlockingGuidance={!hasSeededDraftIntent && !hasSeededRouteIntent}
            composerTopContent={composerTopContent}
            draftId={draftIdentity.draftId}
            statusBadges={statusBadges}
            statusTrailingActions={statusTrailingActions}
        />
    );
}

function NewSessionScreenWithComposerBannerScope() {
    const { draftId } = useLocalSearchParams<{ draftId?: string }>();
    return (
        <ComposerBannerCollapseProvider key={typeof draftId === 'string' ? draftId : 'new-session'}>
            <NewSessionScreen />
        </ComposerBannerCollapseProvider>
    );
}

export default React.memo(NewSessionScreenWithComposerBannerScope);
