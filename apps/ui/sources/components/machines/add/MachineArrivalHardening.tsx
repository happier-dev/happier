import * as React from 'react';
import { machineSetupSourceApplyOriginKeyV1 } from '@happier-dev/protocol/machines/managed/actionsV1';

import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { readBundledMachineSetupPresetChoice, type BundledMachineSetupPresetChoice } from '@/components/settings/machines/managed/machineSetupPresetChoices';
import { presentActionFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { useMachineField, useServerScopedMachine } from '@/sync/store/hooks';
import { t } from '@/text';

import { MachineSetupReviewInPlace } from '../setup/MachineSetupReviewInPlace';
import { MachineSetupRunProgress } from '../setup/MachineSetupRunRegion';
import { useMachineSetup } from '../setup/useMachineSetup';

const SECURE_WEB_HOST = 'happier.machine.recipes/secure-web-host-v1';

type Target = Readonly<{ testID: string; machineId: string; serverId: string; machineName: string }>;

export function MachineArrivalHardening(props: Target) {
    const platform = useMachineField(props.machineId, 'metadata', 'platform', { serverId: props.serverId });
    const canManage = useServerScopedMachine(props.serverId, props.machineId, canManageMachine);
    const [skipped, setSkipped] = React.useState(false);
    if (platform !== 'linux' || !canManage || skipped) return null;
    return <AvailablePreset {...props} onSkip={() => setSkipped(true)} />;
}

function AvailablePreset(props: Target & Readonly<{ onSkip: () => void }>) {
    const projection = useAppShellPluginUiDeclarationProjection();
    const localize = usePluginLocalizedTextResolver({ projection });
    const entry = projection?.machineSetupPresetsById[SECURE_WEB_HOST];
    if (!entry) return null;
    return <HardeningSetup {...props} preset={readBundledMachineSetupPresetChoice(entry, localize)} localize={localize} />;
}

function HardeningSetup(props: Target & Readonly<{
    preset: BundledMachineSetupPresetChoice;
    localize: ReturnType<typeof usePluginLocalizedTextResolver>;
    onSkip: () => void;
}>) {
    const { testID, machineId, serverId, machineName, preset, localize, onSkip } = props;
    const setup = useMachineSetup({ serverId, machineId, active: true, online: true, canCheck: true });
    const review = () => { void setup.prepare({ kind: 'preset', preset }); };
    if (setup.review) {
        return <MachineSetupReviewInPlace setup={setup} machineId={machineId} machineName={machineName} />;
    }
    if (setup.operationId && setup.reviewedSteps) {
        return <MachineSetupRunProgress {...{ serverId, machineId, machineName, setup, localize }} onRetry={review} />;
    }
    const presetKey = machineSetupSourceApplyOriginKeyV1(preset);
    if (!setup.plan || setup.plan.sources.some(source => machineSetupSourceApplyOriginKeyV1(source) === presetKey)) return null;
    const failure = setup.failure;
    return <MachineArrivalHardeningOffer
        testID={testID}
        description={failure ? presentActionFailureOutcome(failure.failure ?? {
            errorCode: failure.code, error: failure.code,
        }).reason ?? t('common.requestFailed') : preset.description}
        failed={failure !== null}
        onReview={review}
        onSkip={onSkip}
    />;
}

export function MachineArrivalHardeningOffer(props: Readonly<{
    testID: string;
    description: string;
    failed?: boolean;
    onReview: () => void;
    onSkip: () => void;
}>) {
    return <AttentionBanner
        testID={props.testID}
        placement="inline"
        tone={props.failed ? 'warning' : 'neutral'}
        title={t('addFlows.machineHardenServer')}
        description={props.description}
        action={{ label: t(props.failed ? 'common.retry' : 'approvals.review'), onPress: props.onReview, testID: `${props.testID}.review` }}
        secondaryAction={{ label: t('common.skip'), onPress: props.onSkip, testID: `${props.testID}.skip` }}
    />;
}
