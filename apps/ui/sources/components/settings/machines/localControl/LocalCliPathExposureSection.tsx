import * as React from 'react';
import type { SystemTaskResult } from '@happier-dev/protocol/system/tasks/spec';
import { LOCAL_CLI_PATH_EXPOSURE_SET_ACTION_ID_V1, LocalDaemonServiceOutputSchema } from '@happier-dev/protocol/actions/specs/localDaemonService';

import { getDefaultSystemTaskRunner } from '@/components/systemTasks';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { Modal } from '@/modal';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { desktopHostKind, invokeDesktopHost } from '@/utils/platform/desktopHost';

function readTaskOutcome(enabled: boolean, result: SystemTaskResult): string {
    if (!result.ok) {
        const message = typeof result.error?.message === 'string' ? result.error.message.trim() : '';
        return message || t('settings.systemTaskStartFailed');
    }
    const data = (result.data ?? {}) as Record<string, unknown>;
    if (!enabled) {
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
function readDesktopEntryAbsent(enabled: boolean, result: SystemTaskResult): boolean | null {
    if (!result.ok) {
        return null;
    }
    if (!enabled) {
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
    const execute = React.useMemo(() => createFrontDoorActionExecute(undefined, { homeRuntimeRunner: runner }), [runner]);
    const [pending, setPending] = React.useState<boolean | null>(null);
    const [outcome, setOutcome] = React.useState<string | null>(null);
    const [startErrorMessage, setStartErrorMessage] = React.useState<string | null>(null);
    const [desktopEntryAbsent, setDesktopEntryAbsent] = React.useState(false);
    const [cleanupBusy, setCleanupBusy] = React.useState(false);
    const [cleanupError, setCleanupError] = React.useState<string | null>(null);
    const cleanupPendingRef = React.useRef(false);
    const isUnavailable = runner.mode === 'unavailable';
    const isBusy = pending !== null;

    const startTask = React.useCallback(async (enabled: boolean) => {
        const { serverId } = getActiveServerSnapshot();
        if (!serverId || isUnavailable || isBusy || cleanupPendingRef.current) {
            return;
        }
        setPending(enabled);
        setOutcome(null);
        setStartErrorMessage(null);
        try {
            const scope = getActiveServerAccountScope();
            const response = await execute(LOCAL_CLI_PATH_EXPOSURE_SET_ACTION_ID_V1, { serverId, enabled }, {
                surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId,
                ...(scope ? { expectedAccountId: scope.accountId } : {}),
            });
            requireActionSuccess(response);
            const { result } = LocalDaemonServiceOutputSchema.parse(response.result);
            const absent = readDesktopEntryAbsent(enabled, result);
            if (absent !== null) setDesktopEntryAbsent(absent);
            setOutcome(readTaskOutcome(enabled, result));
        } catch (error) {
            setStartErrorMessage(isSystemTaskBridgeUnavailableError(error)
                ? t('settings.systemTaskBridgeUnavailable')
                : (readSystemTaskStartErrorMessage(error) ?? t('settings.systemTaskStartFailed')));
        } finally {
            setPending(null);
        }
    }, [execute, isUnavailable, isBusy]);

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
            ?? outcome;

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
                        void startTask(true);
                    }}
                    loading={pending === true}
                    disabled={isUnavailable || isBusy || cleanupBusy}
                />
                <Item
                    testID="settings.localCliPath.remove"
                    title={t('machine.cliPath.removeTitle')}
                    subtitle={t('machine.cliPath.removeSubtitle')}
                    onPress={() => {
                        void startTask(false);
                    }}
                    loading={pending === false}
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
