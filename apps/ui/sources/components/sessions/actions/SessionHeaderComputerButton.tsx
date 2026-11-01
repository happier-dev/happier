import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useOpenSessionComputerScreen } from '@/components/computer/useOpenSessionComputerScreen';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useOptionalSessionViewerController } from '@/components/sessions/viewer/SessionViewerController';
import { useSessionViewerMachineId } from '@/components/sessions/viewer/useSessionViewerMachine';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { SESSION_HEADER_ACTION_SIZE_PX } from './sessionHeaderIconMetrics';
import { useOptionalSessionScreenTestId } from '../shell/sessionScreenTestIds';

/**
 * The one opener of the Session's Computer from a header entry: the canonical opener
 * (`useOpenSessionComputerScreen`) when the Machine can take the request, else the mounted viewer's
 * own `viewer.open`, so a retained offline Machine still opens a viewer that says it isn't answering.
 * Null where no viewer owner is mounted or the Session has no Machine.
 */
function useSessionComputerEntryOpener(input: Readonly<{ sessionId: string; serverId: string | null }>): (() => void) | null {
    const serverId = usePreferredServerIdForSession({ sessionId: input.sessionId, serverId: input.serverId });
    const open = useOpenSessionComputerScreen({ sessionId: input.sessionId, serverId: input.serverId });
    const requestSemantic = useOptionalSessionViewerController()?.requestSemantic;
    const hasMachine = useSessionViewerMachineId(input.sessionId, serverId) !== null;
    const openHere = React.useCallback(() => {
        void requestSemantic?.({ kind: 'viewer.open', source: 'computer' });
    }, [requestSemantic]);
    if (!requestSemantic || !hasMachine) return null;
    return open?.disabledReason ? openHere : open?.open ?? openHere;
}

/**
 * Phone entry to the Session's Computer, for the session actions menu (lab `computer` HC: the phone
 * carries the same entry the desktop header button gives, beside the strip's Stop). A phone header
 * folds its icon actions into that menu, and the presence strip only exists once this device has seen
 * the Computer used, so a fresh phone has no other way in. Null off a phone, where the header button is.
 */
export function useSessionComputerMenuEntry(input: Readonly<{ sessionId: string; serverId: string | null }>): (() => void) | null {
    const open = useSessionComputerEntryOpener(input);
    return useDeviceType() === 'phone' ? open : null;
}

/**
 * Desktop/web session-header entry to the Session's Computer, the sibling of the Browser button.
 * It asks the one canonical opener (`useOpenSessionComputerScreen`, the mounted viewer's
 * `viewer.open` for the computer source) rather than any pane route of its own, so the picture
 * floats beside the reading column exactly as it does from a transcript Watch. Like the Browser
 * button it stays in the header whenever the Session has a Machine, so the header never shifts with
 * the Machine's reachability: while the Machine cannot take the request the viewer opens on this
 * client and its own unavailable state says so. There is no button where no viewer owner is mounted
 * or the Session has no Machine. A phone header folds its icon actions into the session actions
 * menu, which carries the entry there ({@link useSessionComputerMenuEntry}).
 */
export const SessionHeaderComputerButton = React.memo((props: Readonly<{
    sessionId: string;
    serverId: string | null;
}>) => {
    const { theme } = useUnistyles();
    const deviceType = useDeviceType();
    const open = useSessionComputerEntryOpener({ sessionId: props.sessionId, serverId: props.serverId });
    const testId = useOptionalSessionScreenTestId('session-header-computer-button');

    if (deviceType === 'phone' || !open) return null;

    const label = t('computerUse.presentation.sourceComputer');
    return (
        <IconButton
            testID={testId ?? 'session-header-computer-button'}
            variant="plain"
            size={SESSION_HEADER_ACTION_SIZE_PX}
            minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
            accessibilityLabel={label}
            tooltip={label}
            onPress={open}
            icon={<Icon name="desktop" size={ICON_SIZE.sm} color={theme.colors.chrome.header.foreground} />}
        />
    );
});

SessionHeaderComputerButton.displayName = 'SessionHeaderComputerButton';
