import * as React from 'react';
import { USAGE_COACH_DETECTOR_IDS } from '@happier-dev/protocol/usage/coach/coachFinding';
import type { UsageCoachPreferencesV1 } from '@happier-dev/protocol/account/settings/usageCoachPreferencesV1';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { USAGE_SETTINGS } from './usageSettings';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

const MODEL_MODES = ['off', 'suggest_with_estimates', 'complete_only'] as const;

/** Mounted only while configuration is open; the Account declaration owns all persistence/approval. */
export function UsageCoachSettingsGroup(props: Readonly<{ serverId: string; testID: string }>) {
    const preferences = useSetting('usageCoachPreferencesV1');
    const { setSetting, isCurrent } = useSettingActionFeedback({ serverId: props.serverId });
    const [modelOpen, setModelOpen] = React.useState(false);
    const write = (next: UsageCoachPreferencesV1, callerContext?: ActionExecutorContext) => {
        if (!isCurrent()) return false;
        return setSetting(USAGE_SETTINGS.settings.coachPreferences, {
            v: next.v, disabledChecks: next.disabledChecks, modelSuggestion: next.modelSuggestion,
        }, { callerContext });
    };
    const modelMode = preferences.disabledChecks.includes('model_misfit') ? 'off' : preferences.modelSuggestion;
    const checks = USAGE_COACH_DETECTOR_IDS.filter(id => id !== 'model_misfit');
    const commands = useCurrentUiContextLocalCommands([
        ...checks.map(id => ({ key: `check:${id}`, title: t(`usage.board.coach.detector_${id}`),
            invoke: (input?: PluginUiJsonValueV1, context?: ActionExecutorContext) => {
                const enabled = !preferences.disabledChecks.includes(id);
                const next = typeof input === 'boolean' ? input : !enabled;
                return write({ ...preferences, disabledChecks: next ? preferences.disabledChecks.filter(check => check !== id)
                    : [...preferences.disabledChecks.filter(check => check !== id), id] }, context);
            } })),
        { key: 'model-menu', title: t('usage.board.coach.detector_model_misfit'),
            invoke: (input) => setModelOpen(typeof input === 'boolean' ? input : !modelOpen) },
        ...(modelOpen ? MODEL_MODES.map(modelSuggestion => ({ key: `model:${modelSuggestion}`,
            title: `${t('usage.board.coach.detector_model_misfit')}: ${t(`usage.board.coach.modelMode_${modelSuggestion}`)}`,
            invoke: async (_input, context) => {
                const result = await write({ ...preferences, disabledChecks: preferences.disabledChecks.filter(id => id !== 'model_misfit'), modelSuggestion }, context);
                setModelOpen(false);
                return result;
            } })) : []),
    ]);
    return <SettingAnchor setting={USAGE_SETTINGS.settings.coachPreferences}>
        <ItemGroup title={t('usage.board.coach.configure')} description={t('usage.board.coach.checksDescription')}>
            {checks.map(id => {
                const enabled = !preferences.disabledChecks.includes(id);
                const choose = (value: boolean) => { void commands.invoke(`check:${id}`, value); };
                return <Item key={id} testID={`${props.testID}.check.${id}`} title={t(`usage.board.coach.detector_${id}`)}
                    showChevron={false} onPress={() => choose(!enabled)}
                    rightElement={<Switch value={enabled} onValueChange={choose} testID={`${props.testID}.check.${id}.toggle`} />} />;
            })}
            <DropdownMenu testID={`${props.testID}.model`} open={modelOpen} closeOnSelect={false} onOpenChange={open => { void commands.invoke('model-menu', open); }}
                selectedId={modelMode} itemTrigger={{ title: t('usage.board.coach.detector_model_misfit'),
                    subtitle: t('usage.board.coach.modelEvidenceDescription'), showSelectedSubtitle: false }}
                items={MODEL_MODES.map(id => ({ id, title: t(`usage.board.coach.modelMode_${id}`) }))}
                onSelect={choice => {
                    const modelSuggestion = MODEL_MODES.find(mode => mode === choice);
                    if (!modelSuggestion) return;
                    void commands.invoke(`model:${modelSuggestion}`);
                }} />
        </ItemGroup>
    </SettingAnchor>;
}
