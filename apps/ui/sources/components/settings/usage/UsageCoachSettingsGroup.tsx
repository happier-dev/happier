import * as React from 'react';
import { USAGE_COACH_DETECTOR_IDS } from '@happier-dev/protocol/usage/coach/coachFinding';
import type { UsageCoachPreferencesV1 } from '@happier-dev/protocol/account/settings/usageCoachPreferencesV1';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { USAGE_SETTINGS } from './usageSettings';

const MODEL_MODES = ['off', 'suggest_with_estimates', 'complete_only'] as const;

/** Mounted only while configuration is open; the Account declaration owns all persistence/approval. */
export function UsageCoachSettingsGroup(props: Readonly<{ serverId: string; testID: string }>) {
    const preferences = useSetting('usageCoachPreferencesV1');
    const { setSetting, isCurrent } = useSettingActionFeedback({ serverId: props.serverId });
    const [modelOpen, setModelOpen] = React.useState(false);
    const write = (next: UsageCoachPreferencesV1) => {
        if (isCurrent()) void setSetting(USAGE_SETTINGS.settings.coachPreferences, {
            v: next.v, disabledChecks: next.disabledChecks, modelSuggestion: next.modelSuggestion,
        });
    };
    const modelMode = preferences.disabledChecks.includes('model_misfit') ? 'off' : preferences.modelSuggestion;
    return <SettingAnchor setting={USAGE_SETTINGS.settings.coachPreferences}>
        <ItemGroup title={t('usage.board.coach.configure')} description={t('usage.board.coach.checksDescription')}>
            {USAGE_COACH_DETECTOR_IDS.filter(id => id !== 'model_misfit').map(id => {
                const enabled = !preferences.disabledChecks.includes(id);
                const choose = (value: boolean) => write({ ...preferences,
                    disabledChecks: value ? preferences.disabledChecks.filter(check => check !== id)
                        : [...preferences.disabledChecks.filter(check => check !== id), id] });
                return <Item key={id} testID={`${props.testID}.check.${id}`} title={t(`usage.board.coach.detector_${id}`)}
                    showChevron={false} onPress={() => choose(!enabled)}
                    rightElement={<Switch value={enabled} onValueChange={choose} testID={`${props.testID}.check.${id}.toggle`} />} />;
            })}
            <DropdownMenu testID={`${props.testID}.model`} open={modelOpen} onOpenChange={setModelOpen}
                selectedId={modelMode} itemTrigger={{ title: t('usage.board.coach.detector_model_misfit'),
                    subtitle: t('usage.board.coach.modelEvidenceDescription'), showSelectedSubtitle: false }}
                items={MODEL_MODES.map(id => ({ id, title: t(`usage.board.coach.modelMode_${id}`) }))}
                onSelect={choice => {
                    const modelSuggestion = MODEL_MODES.find(mode => mode === choice);
                    if (!modelSuggestion) return;
                    setModelOpen(false);
                    write({ ...preferences, disabledChecks: preferences.disabledChecks.filter(id => id !== 'model_misfit'),
                        modelSuggestion });
                }} />
        </ItemGroup>
    </SettingAnchor>;
}
