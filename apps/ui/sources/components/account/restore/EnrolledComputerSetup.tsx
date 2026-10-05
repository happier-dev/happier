import * as React from 'react';
import { View } from 'react-native';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { buildLocalMachineSetupSystemTaskSpec } from '@/components/systemTasks/buildLocalMachineSetupSystemTaskSpec';
import { SystemTaskProgressCard } from '@/components/systemTasks/SystemTaskProgressCard';
import { useThisComputerSetupTask } from '@/components/systemTasks/useThisComputerSetupTask';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { parseToken } from '@/utils/auth/parseToken';

/** The desktop half of Home enrollment. Registration and service lifecycle stay in setup.thisComputer. */
export function EnrolledComputerSetup(props: Readonly<{
    profileId: string;
    onSucceeded: () => void;
    onBack: () => void;
}>) {
    const profile = getServerProfileById(props.profileId);
    const serverUrl = profile?.serverUrl;
    const serverIdentityId = profile?.serverIdentityId;
    const approval = React.useMemo(() => ({
        expectedRelayUrl: profile?.serverUrl ?? '',
        serverId: props.profileId,
    }), [profile?.serverUrl, props.profileId]);
    const ownedTaskIdRef = React.useRef<string | null>(null);
    const [ownedTaskId, setOwnedTaskId] = React.useState<string | null>(null);
    const onTaskIdChange = React.useCallback((taskId: string | null) => {
        ownedTaskIdRef.current = taskId;
        setOwnedTaskId(taskId);
    }, []);
    const task = useThisComputerSetupTask({
        // Enrollment owns cancellation on leave; it must not adopt another surface's setup.
        taskId: ownedTaskId,
        adoptExisting: false,
        authRequestApproval: approval,
        onSucceeded: props.onSucceeded,
        onTaskIdChange,
    });
    const [preparationError, setPreparationError] = React.useState(false);
    const mountedRef = React.useRef(false);
    const startedRef = React.useRef(false);
    const { start, runner } = task;
    const startSetup = React.useCallback(async () => {
        setPreparationError(false);
        try {
            if (!serverUrl || !serverIdentityId) throw new Error('enrolled_home_unavailable');
            const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId: props.profileId });
            if (!mountedRef.current) return;
            if (!credentials) throw new Error('enrolled_credentials_unavailable');
            const taskId = await start(buildLocalMachineSetupSystemTaskSpec({
                activeRelayUrl: serverUrl,
                activeWebappUrl: serverUrl,
                activeLocalRelayUrl: null,
                activeServerIdentityId: serverIdentityId,
                activeAccountId: parseToken(credentials.token),
                installService: true,
                startService: true,
                verifyService: true,
            }));
            // A bridge start can settle after the user leaves. The mounted prompt owner must not
            // disappear while leaving an unattended setup behind.
            if (!mountedRef.current) await runner.cancel(taskId);
        } catch {
            if (mountedRef.current) setPreparationError(true);
        }
    }, [props.profileId, runner, serverIdentityId, serverUrl, start]);

    React.useEffect(() => {
        mountedRef.current = true;
        if (!startedRef.current) {
            startedRef.current = true;
            void startSetup();
        }
        return () => {
            mountedRef.current = false;
            const taskId = ownedTaskIdRef.current;
            if (taskId && !runner.getSnapshot(taskId)?.result) void runner.cancel(taskId).catch(() => {});
        };
    }, [runner, startSetup]);

    const canRetry = preparationError || Boolean(task.activeTaskSnapshot?.result && !task.activeTaskSnapshot.result.ok);
    return (
        <View testID="enrolled-computer-setup">
            {!task.activeTaskSnapshot && !preparationError ? <View accessibilityLiveRegion="polite">
                <Text>{t('settings.machineSetupCurrentMachineTitle')}</Text>
                <ActivitySpinner size="small" />
            </View> : null}
            {task.activeTaskSnapshot ? (
                <SystemTaskProgressCard snapshot={task.activeTaskSnapshot} onCancel={task.cancel} />
            ) : null}
            {preparationError ? (
                <AttentionBanner testID="enrolled-computer-setup.error" title={t('settings.systemTaskStartFailed')}
                    details={task.startError ? [task.startError] : undefined} announce="alert" />
            ) : null}
            {canRetry ? (
                <RoundButton testID="enrolled-computer-setup.retry" title={t('common.retry')}
                    size="small" disabled={task.isStarting} action={startSetup} />
            ) : null}
            <RoundButton testID="enrolled-computer-setup.back" title={t('common.back')}
                size="small" display="inverted" onPress={props.onBack} />
        </View>
    );
}
