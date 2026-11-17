import * as React from 'react';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { t } from '@/text';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

/** A mounted Details disclosure owns its exact-read demand until it closes. */
export const UsageExactHistoryDemandContext = React.createContext<(() => () => void) | null>(null);

export function useUsageRetryCommand(onRetry: (callerContext?: ActionExecutorContext) => unknown, enabled: boolean): () => void {
    const commands = useCurrentUiContextLocalCommands(enabled ? [{ key: 'retry', title: t('common.retry'),
        invoke: async (_input, callerContext) => { await onRetry(callerContext); } }] : []);
    return React.useCallback(() => { void commands.invoke('retry'); }, [commands.invoke]);
}

/** Publish the mounted disclosure's existing callback; no persisted presentation or second writer. */
export function useUsageDisclosureCommand(title: string, expanded: boolean, onToggle: () => void, enabled = true): () => void {
    const commands = useCurrentUiContextLocalCommands(enabled ? [{ key: 'toggle',
        title: `${title}: ${t(expanded ? 'usage.showLess' : 'usage.showAll')}`, invoke: onToggle }] : []);
    return React.useCallback(() => { void commands.invoke('toggle'); }, [commands.invoke]);
}

/** The public chart owns exact-value rendering; this mounted host owns its local presentation intent. */
export function useUsageChartDetails(title: string, enabled: boolean, loadExactHistory = false): Readonly<{
    valuesExpanded: boolean;
    onValuesExpandedChange(expanded: boolean): void;
}> {
    const [valuesExpanded, setValuesExpanded] = React.useState(false);
    const acquireExactHistory = React.useContext(UsageExactHistoryDemandContext);
    React.useEffect(() => enabled && valuesExpanded && loadExactHistory ? acquireExactHistory?.() : undefined,
        [enabled, valuesExpanded, loadExactHistory, acquireExactHistory]);
    const toggle = useUsageDisclosureCommand(`${title}: ${t('common.details')}`, valuesExpanded,
        () => setValuesExpanded(value => !value), enabled);
    const onValuesExpandedChange = React.useCallback((expanded: boolean) => {
        if (expanded !== valuesExpanded) toggle();
    }, [toggle, valuesExpanded]);
    return { valuesExpanded, onValuesExpandedChange };
}
