import * as React from 'react';
import type { MachineResourcesPolicyState } from '@/sync/domains/machines/resources/useMachineResourcesPolicy';
import { formatElapsedDuration } from '@/components/machines/durationWords';
import { formatPolicyDurationInput, parsePolicyDuration } from '@/components/machines/policy/policyDuration';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { GuardSelectRow } from './guardRows';

/** Controls use the same resources document and Action as every other machine rule. */
export function AgentToolsSection(props: Readonly<{ settings: MachineResourcesPolicyState; editable: boolean; machineName: string }>) {
    const policy = props.settings.policy?.processes;
    const [failed, setFailed] = React.useState<ReadonlySet<'idle' | 'browsers'>>(() => new Set());
    const { set } = props.settings;
    if (!policy) return null;
    const failure = (row: 'idle' | 'browsers') => failed.has(row) ? t('machineGuard.saveFailed', { machine: props.machineName }) : null;
    const save = (row: 'idle' | 'browsers', processes: Parameters<typeof set>[0]['processes']) => {
        fireAndForget((async () => {
            const result = await set({ processes });
            setFailed(previous => { const next = new Set(previous); if (result.saved) next.delete(row); else next.add(row); return next; });
        })(), { tag: 'AgentToolsSection.save' });
    };
    return <ItemGroup title={t('machineGuard.tools.title')}>
        <GuardSelectRow<number | null> testID="machine-guard-tool-idle" title={t('machineGuard.tools.idleTitle')}
            subtitle={t('machineGuard.tools.idleHelp')} label={t('machineGuard.tools.idleTitle')}
            value={policy.toolIdleCloseMs} format={value => value === null ? t('machineGuard.off')
                : value < 60_000 && value % 1000 === 0 || value % 60_000 === 0 ? formatElapsedDuration(value)
                    : t('machineGuard.tools.milliseconds', { milliseconds: value })}
            presets={[null, 300_000, 600_000, 1_800_000]} editable={props.editable} failed={failure('idle')}
            custom={{ title: t('machineGuard.tools.customIdle.title'), body: t('machineGuard.tools.customIdle.body'), invalid: t('machineGuard.tools.customIdle.invalid'),
                defaultValue: formatPolicyDurationInput(policy.toolIdleCloseMs ?? 300_000), parse: raw => parsePolicyDuration(raw, { unit: 'ms', minimum: 1000 }) }}
            onChange={toolIdleCloseMs => save('idle', { toolIdleCloseMs })} />
        <GuardSelectRow<number | null> testID="machine-guard-browser-limit" title={t('machineGuard.tools.browserTitle')}
            subtitle={t('machineGuard.tools.browserHelp')} label={t('machineGuard.tools.browserTitle')}
            value={policy.browserMaxConcurrent} format={value => value === null ? t('machineGuard.tools.automatic') : String(value)}
            presets={[null, 1, 2, 3, 4]} editable={props.editable} failed={failure('browsers')}
            custom={{ title: t('machineGuard.tools.customBrowsers.title'), body: t('machineGuard.tools.customBrowsers.body'), invalid: t('machineGuard.tools.customBrowsers.invalid'),
                defaultValue: String(policy.browserMaxConcurrent ?? ''), parse: raw => {
                    const value = Number(raw.trim()); return Number.isSafeInteger(value) && value > 0 ? value : null;
                } }}
            onChange={browserMaxConcurrent => save('browsers', { browserMaxConcurrent })} />
    </ItemGroup>;
}
