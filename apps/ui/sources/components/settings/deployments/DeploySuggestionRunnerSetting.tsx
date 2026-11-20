import * as React from 'react';

import type { LlmTaskRunnerChoiceV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { presentSettingWriteFailure } from '@/components/settings/shell/writeFailure';
import { LlmTaskRunnerPicker } from '@/components/settings/llmTasks/LlmTaskRunnerPicker';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { DEPLOYMENTS_SETTINGS } from './deploymentsSettings';

/**
 * Describe your app runs on the background-task runner this picks (the same picker commit messages use). Settings and a
 * failed suggestion both render it and write the one `deploySuggestionRunnerV1` setting through `settings.set`.
 */
export function DeploySuggestionRunnerSetting(props: Readonly<{
    serverId: string;
    execution: ReturnType<typeof useMountedActionExecution>;
    /** The Machine whose runners the picker reads; this computer by default. */
    machineId?: string | null;
    testIDPrefix: string;
}>) {
    const [choice] = useSettingMutable('deploySuggestionRunnerV1');
    const thisComputer = useThisComputerMachineId();
    const { execution } = props;
    const write = React.useCallback((value: LlmTaskRunnerChoiceV1) => { void (async () => {
        try {
            const result = await execution.execute('settings.set', { anchor: DEPLOYMENTS_SETTINGS.settings.suggestionAgent.anchor, value });
            if (!result.ok) presentSettingWriteFailure(result);
        } catch (error) { presentSettingWriteFailure(error); }
    })(); }, [execution]);
    return <ItemGroup title={t('projects.deployments.autoSectionTitle')}>
        <LlmTaskRunnerPicker task="deploy_suggestion" value={choice} machineId={props.machineId ?? thisComputer} serverId={props.serverId}
            engineFieldTitle={t('projects.deployments.autoAgentTitle')} disabled={!execution.ready}
            testIDPrefix={props.testIDPrefix} onChange={write} />
    </ItemGroup>;
}
