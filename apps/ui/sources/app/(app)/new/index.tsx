import React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { PopoverBoundaryProvider, PopoverPortalTargetProvider } from '@/components/ui/popover';
import { SessionGettingStartedGuidance, useSessionGettingStartedGuidanceBaseModel } from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { NewSessionSimplePanel } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { NewSessionWizard } from '@/components/sessions/new/components/NewSessionWizard';
import { useNewSessionScreenModel } from '@/components/sessions/new/hooks/useNewSessionScreenModel';
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
        <View ref={model.popoverBoundaryRef} style={{ flex: 1, width: '100%' }}>
            <PopoverPortalTargetProvider>
                <PopoverBoundaryProvider boundaryRef={model.popoverBoundaryRef}>
                    <NewSessionWizard
                        layout={layout}
                        profiles={profiles}
                        agent={agent}
                        machine={machine}
                        footer={footer}
                    />
                </PopoverBoundaryProvider>
            </PopoverPortalTargetProvider>
        </View>
    );
}

function NewSessionScreen() {
    const baseModel = useSessionGettingStartedGuidanceBaseModel();
    const { dataId } = useLocalSearchParams<{ dataId?: string; spawnServerId?: string }>();

    const hasSeededDraftIntent = React.useMemo(() => {
        const persistedDraft = loadNewSessionDraft();
        const tempData = typeof dataId === 'string' ? peekTempData<NewSessionData>(dataId) : null;

        return hasSeededCheckoutIntent({
            ...persistedDraft,
            checkoutCreationDraft: tempData?.checkoutCreationDraft ?? persistedDraft?.checkoutCreationDraft,
        });
    }, [dataId]);

    if (baseModel.kind === 'connect_machine' && !hasSeededDraftIntent) {
        return <SessionGettingStartedGuidance variant="newSessionBlocking" />;
    }
    return <NewSessionScreenInner />;
}

export default React.memo(NewSessionScreen);
