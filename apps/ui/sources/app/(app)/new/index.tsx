import React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { SessionGettingStartedGuidance, useSessionGettingStartedGuidanceBaseModel } from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { NewSessionSimplePanel } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { NewSessionWizard } from '@/components/sessions/new/components/NewSessionWizard';
import { useNewSessionScreenModel } from '@/components/sessions/new/hooks/useNewSessionScreenModel';
import { PopoverScope } from '@/components/ui/popover';
import { parseNewSessionCheckoutDraft } from '@/sync/domains/state/newSessionCheckoutDraft';
import { loadNewSessionDraft } from '@/sync/domains/state/persistence';
import { peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';

function hasSeededCheckoutIntent(value: unknown): boolean {
    const draft = parseNewSessionCheckoutDraft(value);
    return draft.checkoutCreationDraft !== null;
}

function NewSessionScreenInner() {
    const model = useNewSessionScreenModel();

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

function NewSessionScreen() {
    const baseModel = useSessionGettingStartedGuidanceBaseModel();
    const { dataId, machineId, directory } = useLocalSearchParams<{
        dataId?: string;
        spawnServerId?: string;
        machineId?: string;
        directory?: string;
    }>();

    const hasSeededDraftIntent = React.useMemo(() => {
        const persistedDraft = loadNewSessionDraft();
        const tempData = typeof dataId === 'string' ? peekTempData<NewSessionData>(dataId) : null;

        return hasSeededCheckoutIntent({
            ...persistedDraft,
            checkoutCreationDraft: tempData?.checkoutCreationDraft ?? persistedDraft?.checkoutCreationDraft,
        });
    }, [dataId]);

    const hasSeededRouteIntent = React.useMemo(() => {
        return (
            (typeof machineId === 'string' && machineId.trim().length > 0)
            || (typeof directory === 'string' && directory.trim().length > 0)
        );
    }, [machineId, directory]);

    if (baseModel.kind === 'connect_machine' && !hasSeededDraftIntent && !hasSeededRouteIntent) {
        return (
            <PopoverScope>
                <SessionGettingStartedGuidance variant="newSessionBlocking" />
            </PopoverScope>
        );
    }
    return (
        <PopoverScope>
            <NewSessionScreenInner />
        </PopoverScope>
    );
}

export default React.memo(NewSessionScreen);
