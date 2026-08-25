import React from 'react';

import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { t } from '@/text';

export type AutomationRunNowState = 'idle' | 'running' | 'queued';

/**
 * Sole owner of the per-Automation "Run now" pending state and its in-flight
 * guard. The screen owns the controller so a virtualized row that scrolls out
 * of view cannot drop an in-flight guard and let the same Automation be started
 * twice, and so the queued acknowledgement survives recycling.
 */
export type AutomationRunNowController = Readonly<{
    stateFor: (automationId: string) => AutomationRunNowState;
    runNow: (automationId: string) => Promise<void>;
}>;

const QUEUED_ACKNOWLEDGEMENT_MS = 2500;

export function useAutomationRunNowController(): AutomationRunNowController {
    const [stateById, setStateById] = React.useState<Record<string, AutomationRunNowState>>({});
    const inFlightIdsRef = React.useRef(new Set<string>());

    const runNow = React.useCallback(async (automationId: string) => {
        if (inFlightIdsRef.current.has(automationId)) return;
        inFlightIdsRef.current.add(automationId);
        try {
            setStateById((prev) => ({ ...prev, [automationId]: 'running' }));
            await sync.runAutomationNow(automationId);
            setStateById((prev) => ({ ...prev, [automationId]: 'queued' }));
            setTimeout(() => {
                setStateById((prev) => {
                    if (prev[automationId] !== 'queued') return prev;
                    const { [automationId]: _ignored, ...rest } = prev;
                    return rest;
                });
            }, QUEUED_ACKNOWLEDGEMENT_MS);
        } catch (error) {
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.detail.runFailed'),
            );
            setStateById((prev) => {
                const { [automationId]: _ignored, ...rest } = prev;
                return rest;
            });
        } finally {
            inFlightIdsRef.current.delete(automationId);
        }
    }, []);

    return React.useMemo(() => ({
        stateFor: (automationId: string) => stateById[automationId] ?? 'idle',
        runNow,
    }), [runNow, stateById]);
}
