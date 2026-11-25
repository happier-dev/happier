import * as React from 'react';

import type { LlmTaskRunnerChoiceV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { presentSettingWriteFailure } from '@/components/settings/shell/writeFailure';
import { LlmTaskRunnerPicker } from '@/components/settings/llmTasks/LlmTaskRunnerPicker';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { subscribeScopedAccountSettings } from '@/sync/ops/account/scopedAccountSettings';
import { t } from '@/text';

import { DEPLOYMENTS_SETTINGS } from './deploymentsSettings';

/** Undefined while the exact Account choice is unavailable. A stored null means Auto. */
export function useDeploymentSuggestionRunner(lifetime: ServerAccountScopeLifetime | null) {
    const [value, setValue] = React.useState<Readonly<{
        lifetime: ServerAccountScopeLifetime; choice: LlmTaskRunnerChoiceV1 | null;
    }> | null>(null);
    React.useEffect(() => {
        if (!lifetime) return;
        return subscribeScopedAccountSettings(lifetime, ['deploySuggestionRunnerV1'], settings => {
            setValue(settings && lifetime.isCurrent() ? { lifetime, choice: settings.deploySuggestionRunnerV1 } : null);
        });
    }, [lifetime]);
    return value?.lifetime === lifetime ? value.choice : undefined;
}

export function DeploySuggestionRunnerField(props: Readonly<{
    serverId: string;
    machineId: string | null;
    value: LlmTaskRunnerChoiceV1 | null | undefined;
    disabled: boolean;
    testIDPrefix: string;
    onChange: (value: LlmTaskRunnerChoiceV1) => void;
}>) {
    return <ItemGroup title={t('projects.deployments.autoSectionTitle')}>
        <LlmTaskRunnerPicker task="deploy_suggestion" value={props.value} machineId={props.machineId} serverId={props.serverId}
            engineFieldTitle={t('projects.deployments.autoAgentTitle')} disabled={props.disabled}
            testIDPrefix={props.testIDPrefix} onChange={props.onChange} />
    </ItemGroup>;
}

/** The deliberate Account preference for the Describe your app runner. */
export function DeploySuggestionRunnerSetting(props: Readonly<{
    serverId: string;
    execution: ReturnType<typeof useMountedActionExecution>;
    testIDPrefix: string;
}>) {
    const stored = useDeploymentSuggestionRunner(props.execution.binding ?? null);
    const thisComputer = useThisComputerMachineId();
    const { execution } = props;
    const write = React.useCallback((value: LlmTaskRunnerChoiceV1) => { void (async () => {
        try {
            const result = await execution.execute('settings.set', { anchor: DEPLOYMENTS_SETTINGS.settings.suggestionAgent.anchor, value });
            if (!result.ok) presentSettingWriteFailure(result);
        } catch (error) { presentSettingWriteFailure(error); }
    })(); }, [execution]);
    return <DeploySuggestionRunnerField serverId={props.serverId} machineId={thisComputer} value={stored}
        disabled={!execution.ready || stored === undefined} testIDPrefix={props.testIDPrefix} onChange={write} />;
}
