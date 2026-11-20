import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useHomeSettingsSelection } from '@/hooks/home/useHomeSettingsWithCompanion';
import { t } from '@/text';

import { useHomeRuntimeExecutor } from '../runtime/homeRuntimeExecutor';
import {
    HomeRuntimeRestartSections,
    countPendingRestartChanges,
    useHomeServerRelease,
} from '../runtime/HomeRuntimeSections';
import { HomeAdministrationSection } from './HomeAdministrationSection';
import type { HomeAdministrationContext } from './homeAdministrationContext';
import { homeGovernanceFailureNotice } from './homeGovernanceLabels';

const RuntimePage = React.memo(function RuntimePage(props: Readonly<{ context: HomeAdministrationContext }>) {
    const { context } = props;
    const canView = context.projection.capabilities.viewAdministration;
    const release = useHomeServerRelease(context.scope.serverId, canView);
    const executor = useHomeRuntimeExecutor(context.scope.serverId, release.flavor);
    const reads = useHomeSettingsSelection(context.scope, canView, countPendingRestartChanges);
    const settingsUnknown = reads.loading || reads.failure !== null || reads.settings === null;

    if (!canView) {
        return (
            <ItemGroup>
                <SurfaceStateCard
                    testID="home-runtime-forbidden"
                    kind="denied"
                    size="line"
                    title={t('homeGovernance.forbiddenTitle')}
                    reason={t('homeGovernance.forbiddenBody')}
                />
            </ItemGroup>
        );
    }
    return (
        <>
            {settingsUnknown ? <SurfaceStateCard
                size="line"
                testID="home-runtime-settings-unknown"
                kind={reads.failure ? 'error' : 'loading'}
                title={reads.failure ? t('homeGovernance.overviewPage.settingsFailed') : t('homeGovernance.loading')}
                reason={reads.failure ? homeGovernanceFailureNotice(reads.failure, { effect: 'read' }).body : undefined}
                action={reads.failure ? { label: t('homeGovernance.retry'), onPress: reads.reload, testID: 'home-runtime-settings-retry' } : undefined}
                accessibilitySemantics={reads.failure ? 'alert' : 'status'}
            /> : null}
            <HomeRuntimeRestartSections
                context={context}
                executor={executor}
                release={release}
                pendingCount={settingsUnknown ? null : reads.settings}
                onRestarted={reads.reload}
            />
        </>
    );
});

/**
 * The server that runs this Home (plan §3.7, lab `hcRuntime-*`): the release the server reports,
 * changes waiting for a restart, and the runtime controls of whoever can act on it — this desktop
 * when it hosts the Home, its Remote host or connected Machine, or nobody here (it says where).
 */
export const HomeAdministrationRuntimeScreen = React.memo(function HomeAdministrationRuntimeScreen(
    props: Readonly<{ serverId: string }>,
) {
    return (
        <HomeAdministrationSection
            serverId={props.serverId}
            title={t('homeGovernance.runtime.title')}
            description={t('homeGovernance.pages.runtime')}
        >
            {(context) => <RuntimePage context={context} />}
        </HomeAdministrationSection>
    );
});
