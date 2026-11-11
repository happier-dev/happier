import * as React from 'react';
import type { SystemTaskResult } from '@happier-dev/protocol';

import { getDefaultSystemTaskRunner, useSystemTaskSnapshot } from '@/components/systemTasks';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { invokeTauri, isTauriDesktop } from '@/utils/platform/tauri';

import { buildLocalDaemonServiceSystemTaskSpec } from './buildLocalDaemonServiceSystemTaskSpec';

type CliPathExposureTaskKind = 'cli.pathExposure.ensure.v1' | 'cli.pathExposure.remove.v1';

function readTaskOutcome(kind: CliPathExposureTaskKind, result: SystemTaskResult | null): string | null {
    if (!result) {
        return null;
    }
    if (!result.ok) {
        const message = typeof result.error?.message === 'string' ? result.error.message.trim() : '';
        return message || t('settings.systemTaskStartFailed');
    }
    const data = (result.data ?? {}) as Record<string, unknown>;
    if (kind === 'cli.pathExposure.remove.v1') {
        return data.removed === true ? t('machine.cliPath.removed') : t('machine.cliPath.nothingToRemove');
    }
    if (data.changed !== true) {
        // Another `happier` already answers in the terminal and was deliberately left in front, so
        // nothing was added; say which one, rather than claiming ours is already there (R17).
        const existingCommand = typeof data.existingCommand === 'string' ? data.existingCommand.trim() : '';
        return existingCommand
            ? t('machine.cliPath.existingCommand', { path: existingCommand })
            : t('machine.cliPath.alreadyPresent');
    }
    return typeof data.shellReloadHint === 'string' && data.shellReloadHint.trim()
        ? data.shellReloadHint.trim()
        : t('machine.cliPath.added');
}

/**
 * Settings repair action for R6/INV5: PATH exposure is ancillary to setup, so when the automatic
 * attempt fails (read-only profile, unsupported environment) the user can retry or undo it here.
 */
export const LocalCliPathExposureSection = React.memo(function LocalCliPathExposureSection(props: Readonly<{
    runner?: SystemTaskRunner;
}>) {
    const runner = props.runner ?? getDefaultSystemTaskRunner();
    const [activeTask, setActiveTask] = React.useState<Readonly<{ kind: CliPathExposureTaskKind; taskId: string }> | null>(null);
    const [startErrorMessage, setStartErrorMessage] = React.useState<string | null>(null);
    const [cleanupBusy, setCleanupBusy] = React.useState(false);
    const [cleanupError, setCleanupError] = React.useState<string | null>(null);
    const cleanupPendingRef = React.useRef(false);
    const snapshot = useSystemTaskSnapshot(runner, activeTask?.taskId ?? null);
    const isUnavailable = runner.mode === 'unavailable';
    const isBusy = activeTask != null && snapshot?.result == null;

    const startTask = React.useCallback(async (kind: CliPathExposureTaskKind) => {
        if (isUnavailable || isBusy || cleanupPendingRef.current) {
            return;
        }
        try {
            const taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec(kind));
            setStartErrorMessage(null);
            setActiveTask({ kind, taskId });
        } catch (error) {
            setActiveTask(null);
            setStartErrorMessage(isSystemTaskBridgeUnavailableError(error)
                ? t('settings.systemTaskBridgeUnavailable')
                : (readSystemTaskStartErrorMessage(error) ?? t('settings.systemTaskStartFailed')));
        }
    }, [isUnavailable, isBusy, runner]);

    const removeDesktopComponents = React.useCallback(async () => {
        if (!isTauriDesktop() || isBusy || cleanupPendingRef.current) return;
        // Admit once before the asynchronous confirmation, including repeated keyboard activation.
        cleanupPendingRef.current = true;
        let cleaned = false;
        try {
            const confirmed = await Modal.confirm(
                t('machine.cliPath.cleanupConfirmTitle'),
                t('machine.cliPath.cleanupConfirmBody'),
                {
                    cancelText: t('common.cancel'),
                    confirmText: t('machine.cliPath.cleanupConfirmAction'),
                    destructive: true,
                },
            );
            if (!confirmed) return;
            setCleanupError(null);
            setCleanupBusy(true);
            await invokeTauri<void>('desktop_uninstall_components');
            cleaned = true;
            // Successful native cleanup prepares the existing shutdown owner to exit directly.
            await invokeTauri<void>('desktop_finish_shutdown');
        } catch (error) {
            const message = t(cleaned ? 'machine.cliPath.cleanupQuitFailed' : 'machine.cliPath.cleanupFailed');
            const reason = readSystemTaskStartErrorMessage(error);
            setCleanupError(reason ? `${message}\n\n${reason}` : message);
        } finally {
            cleanupPendingRef.current = false;
            setCleanupBusy(false);
        }
    }, [isBusy]);

    const statusSubtitle = startErrorMessage
        ?? (activeTask ? readTaskOutcome(activeTask.kind, snapshot?.result ?? null) : null);

    return (
        <>
            <ItemGroup title={t('machine.cliPath.title')} footer={t('machine.cliPath.footer')}>
                {statusSubtitle ? (
                    <Item
                        testID="settings.localCliPath.status"
                        title={t('machine.status')}
                        subtitle={statusSubtitle}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
                <Item
                    testID="settings.localCliPath.add"
                    title={t('machine.cliPath.addTitle')}
                    subtitle={t('machine.cliPath.addSubtitle')}
                    onPress={() => {
                        void startTask('cli.pathExposure.ensure.v1');
                    }}
                    disabled={isUnavailable || isBusy || cleanupBusy}
                />
                <Item
                    testID="settings.localCliPath.remove"
                    title={t('machine.cliPath.removeTitle')}
                    subtitle={t('machine.cliPath.removeSubtitle')}
                    onPress={() => {
                        void startTask('cli.pathExposure.remove.v1');
                    }}
                    disabled={isUnavailable || isBusy || cleanupBusy}
                />
            </ItemGroup>
            {isTauriDesktop() ? (
                <ItemGroup title={t('settingsDesktop.title')}>
                    {cleanupError ? (
                        <Item
                            testID="settings.localDesktop.cleanupStatus"
                            title={t('common.error')}
                            subtitle={cleanupError}
                            subtitleLines={0}
                            showChevron={false}
                            mode="info"
                        />
                    ) : null}
                    <Item
                        testID="settings.localDesktop.cleanup"
                        title={t('machine.cliPath.cleanupTitle')}
                        subtitle={t(cleanupBusy ? 'machine.cliPath.cleanupBusy' : 'machine.cliPath.cleanupSubtitle')}
                        subtitleLines={0}
                        showChevron={false}
                        destructive
                        loading={cleanupBusy}
                        disabled={isBusy || cleanupBusy}
                        onPress={removeDesktopComponents}
                    />
                </ItemGroup>
            ) : null}
        </>
    );
});
