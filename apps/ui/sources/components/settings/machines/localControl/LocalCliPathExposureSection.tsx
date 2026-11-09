import * as React from 'react';
import type { SystemTaskResult } from '@happier-dev/protocol/system/tasks/spec';

import { getDefaultSystemTaskRunner, useSystemTaskSnapshot } from '@/components/systemTasks';
import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/systemTasks/specs/localControl/buildLocalDaemonServiceSystemTaskSpec';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { Modal } from '@/modal';
import { t } from '@/text';
import { desktopHostKind, invokeDesktopHost } from '@/utils/platform/desktopHost';

type CliPathExposureTaskKind = 'cli.pathExposure.ensure.v1' | 'cli.pathExposure.remove.v1';

function readTaskOutcome(kind: CliPathExposureTaskKind, result: SystemTaskResult): string {
    if (!result.ok) {
        const message = typeof result.error?.message === 'string' ? result.error.message.trim() : '';
        return message || t('settings.systemTaskStartFailed');
    }
    const data = (result.data ?? {}) as Record<string, unknown>;
    if (kind === 'cli.pathExposure.remove.v1') {
        return data.removed === true ? t('machine.cliPath.removed') : t('machine.cliPath.nothingToRemove');
    }
    if (data.changed !== true) {
        return t('machine.cliPath.alreadyPresent');
    }
    return typeof data.shellReloadHint === 'string' && data.shellReloadHint.trim()
        ? data.shellReloadHint.trim()
        : t('machine.cliPath.added');
}

/**
 * Whether the owner has just proven this computer has no Happier-created PATH entry left, so
 * removal has nothing to offer. Both facts come from the owner's own result — the UI never
 * re-derives which entry Happier may touch (INV5). `changed: false` is deliberately not one of
 * them: an entry that is already present may be the shell installer's, which removal never claims.
 */
function readDesktopEntryAbsent(kind: CliPathExposureTaskKind, result: SystemTaskResult): boolean | null {
    if (!result.ok) {
        return null;
    }
    if (kind === 'cli.pathExposure.remove.v1') {
        return true;
    }
    return (result.data as Record<string, unknown> | undefined)?.changed === true ? false : null;
}

/**
 * Settings repair action for R6/INV5. PATH exposure is ancillary to setup: when the automatic
 * attempt during setup fails (read-only profile, unsupported shell) it is reported quietly and
 * this is where the user retries it — or undoes what Happier added.
 */
export const LocalCliPathExposureSection = React.memo(function LocalCliPathExposureSection(props: Readonly<{
    runner?: SystemTaskRunner;
}>) {
    const runner = props.runner ?? getDefaultSystemTaskRunner();
    const [activeTask, setActiveTask] = React.useState<Readonly<{ kind: CliPathExposureTaskKind; taskId: string }> | null>(null);
    const [startErrorMessage, setStartErrorMessage] = React.useState<string | null>(null);
    const [desktopEntryAbsent, setDesktopEntryAbsent] = React.useState(false);
    const [cleanupBusy, setCleanupBusy] = React.useState(false);
    const [cleanupError, setCleanupError] = React.useState<string | null>(null);
    const cleanupPendingRef = React.useRef(false);
    const snapshot = useSystemTaskSnapshot(runner, activeTask?.taskId ?? null);
    const result = snapshot?.result ?? null;
    const isUnavailable = runner.mode === 'unavailable';
    const isBusy = activeTask != null && result == null;

    const handledResultTaskIdRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!activeTask || !result || handledResultTaskIdRef.current === activeTask.taskId) {
            return;
        }
        handledResultTaskIdRef.current = activeTask.taskId;
        const absent = readDesktopEntryAbsent(activeTask.kind, result);
        if (absent !== null) {
            setDesktopEntryAbsent(absent);
        }
    }, [activeTask, result]);

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

    const removeDesktopComponents = useEventCallback(async () => {
        if (desktopHostKind() !== 'tauri' || isBusy || cleanupPendingRef.current) return;
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
            await invokeDesktopHost<void>('desktop_uninstall_components');
            cleaned = true;
            // Successful native cleanup prepares the existing shutdown owner to exit directly.
            await invokeDesktopHost<void>('desktop_finish_shutdown');
        } catch (error) {
            const message = t(cleaned ? 'machine.cliPath.cleanupQuitFailed' : 'machine.cliPath.cleanupFailed');
            const reason = readSystemTaskStartErrorMessage(error);
            setCleanupError(reason ? `${message}\n\n${reason}` : message);
        } finally {
            cleanupPendingRef.current = false;
            setCleanupBusy(false);
        }
    });

    const statusSubtitle = isUnavailable
        ? t('settings.systemTaskBridgeUnavailable')
        : startErrorMessage
            ?? (isBusy ? t('machine.cliPath.working') : null)
            ?? (activeTask && result ? readTaskOutcome(activeTask.kind, result) : null);

    return (
        <>
            <ItemGroup title={t('machine.cliPath.title')} description={t('machine.cliPath.footer')}>
                {statusSubtitle ? (
                    <Item
                        testID="settings.localCliPath.status"
                        title={t('machine.status')}
                        subtitle={statusSubtitle}
                        subtitleLines={0}
                        accessibilityLiveRegion="polite"
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
                    loading={isBusy && activeTask?.kind === 'cli.pathExposure.ensure.v1'}
                    disabled={isUnavailable || isBusy || cleanupBusy}
                />
                <Item
                    testID="settings.localCliPath.remove"
                    title={t('machine.cliPath.removeTitle')}
                    subtitle={t('machine.cliPath.removeSubtitle')}
                    onPress={() => {
                        void startTask('cli.pathExposure.remove.v1');
                    }}
                    loading={isBusy && activeTask?.kind === 'cli.pathExposure.remove.v1'}
                    disabled={isUnavailable || isBusy || cleanupBusy || desktopEntryAbsent}
                />
            </ItemGroup>
            {desktopHostKind() === 'tauri' ? (
                <ItemGroup title={t('settingsDesktop.title')}>
                    {cleanupError ? (
                        <Item
                            testID="settings.localDesktop.cleanupStatus"
                            title={t('common.error')}
                            subtitle={cleanupError}
                            subtitleLines={0}
                            accessibilityLiveRegion="polite"
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
