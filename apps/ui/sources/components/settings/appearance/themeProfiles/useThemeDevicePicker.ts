import * as React from 'react';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import type { ThemeProfileMode, ThemeReference } from '@/theme/profiles/themeProfileTypes';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ThemeDevicePickerRow, ThemeDevicePickerViewProps } from './themeDevicePickerViewTypes';
import type { ThemeUiActionExecute } from './useThemeActionExecution';
import type { ThemeResultDistribution } from '@/components/tools/renderers/system/themeActionResultViewTypes';

export type ThemeDevicePickerInput = Readonly<{
    enabled: boolean;
    theme: Readonly<{ reference: ThemeReference | null; name: string; mode: ThemeProfileMode }>;
    currentClientId: string;
    unnamedDeviceLabel: string;
    onDismiss: () => void;
    onDistribution?: (result: ThemeResultDistribution) => void;
}>;

/** One discovery per open or explicit retry; no device history, polling or library writes. */
export function useThemeDevicePicker(input: ThemeDevicePickerInput, execute: ThemeUiActionExecute): ThemeDevicePickerViewProps {
    const [state, setState] = React.useState<ThemeDevicePickerViewProps['state']>('loading');
    const [rows, setRows] = React.useState<readonly ThemeDevicePickerRow[]>([]);
    const [dispatching, setDispatching] = React.useState(false);
    const [retry, setRetry] = React.useState(0);
    React.useEffect(() => {
        if (!input.enabled) return;
        const controller = new AbortController();
        setState('loading');
        void execute(THEME_ACTION_IDS.list, { includeDevices: true }, { signal: controller.signal }).then(result => {
            if (controller.signal.aborted) return;
            if (!result.devices) { setState('error'); return; }
            setRows(result.devices.map(candidate => ({ id: candidate.id, label: candidate.deviceLabel,
                computer: candidate.state?.computer ?? false, current: candidate.id === input.currentClientId,
                checked: false, outcome: null })).sort((left, right) => Number(right.current) - Number(left.current)));
            setState('ready');
        }).catch(() => { if (!controller.signal.aborted) setState('error'); });
        return () => controller.abort();
    }, [execute, input.enabled, input.currentClientId, retry]);
    const onToggle = React.useCallback((id: string) => {
        if (dispatching) return;
        setRows(previous => previous.map(row => row.id === id && !row.current && row.outcome !== 'applied'
            ? { ...row, checked: !row.checked } : row));
    }, [dispatching]);
    const onUse = React.useCallback(() => {
        if (dispatching) return;
        const targets = rows.filter(row => row.checked && !row.current && row.outcome !== 'applied');
        if (!targets.length) return;
        const targetIds = new Set(targets.map(row => row.id));
        setDispatching(true);
        setRows(previous => previous.map(row => targetIds.has(row.id) ? { ...row, outcome: 'applying' } : row));
        void Promise.all(targets.map(async row => {
            let outcome: 'applied' | 'disconnected' | 'failed';
            try {
                await execute(THEME_ACTION_IDS.apply, { ref: input.theme.reference, mode: input.theme.mode, clientId: row.id });
                outcome = 'applied';
            } catch (error) {
                outcome = readActionErrorCodeV1(error) === 'client_not_connected' ? 'disconnected' : 'failed';
            }
            return { row, outcome };
        })).then(results => {
            const outcomes = new Map(results.map(result => [result.row.id, result.outcome]));
            setRows(previous => previous.map(row => {
                const outcome = outcomes.get(row.id);
                return outcome ? { ...row, outcome } : row;
            }));
            input.onDistribution?.({
                applied: results.filter(result => result.outcome === 'applied').map(result => result.row.label ?? input.unnamedDeviceLabel),
                failed: results.filter(result => result.outcome !== 'applied').map(result => ({
                    label: result.row.label ?? input.unnamedDeviceLabel,
                    reason: result.outcome === 'disconnected' ? 'disconnected' : 'failed',
                })),
            });
        }).finally(() => setDispatching(false));
    }, [dispatching, rows, execute, input.theme, input.onDistribution, input.unnamedDeviceLabel]);
    return { themeName: input.theme.name, mode: input.theme.mode, state, rows, dispatching,
        onToggle, onUse, onRetry: () => setRetry(value => value + 1), onDismiss: input.onDismiss };
}
