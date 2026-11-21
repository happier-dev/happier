import * as React from 'react';

import { isLlmTaskRunnerAutoV1, type LlmTaskRunnerChoiceV1, type LlmTaskRunnerConfigV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
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
    /**
     * A failed suggestion's runner that hit a usage limit. While the stored choice is still Auto, the picker opens on it,
     * so its Runs through choice lists that Agent's other routes; picking one writes an explicit runner (the person's
     * visible retry; Auto reads no quota per selection, Providers ORCH 11-21 17:11Z).
     */
    limited?: LlmTaskRunnerConfigV1;
    testIDPrefix: string;
}>) {
    const [stored] = useSettingMutable('deploySuggestionRunnerV1');
    const choice = props.limited && isLlmTaskRunnerAutoV1(stored) ? props.limited : stored;
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
