import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { usePaneHeaderSlotContent } from '@/components/appShell/panes/paneHeaderSlot';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

type BrowserSurfacePaneHeaderProps = Readonly<{
    presentation?: 'workspace' | 'viewer';
    serverId: string | null;
    machineId: string | null;
}>;

function WorkspacePaneHeader(props: BrowserSurfacePaneHeaderProps): null {
    const { theme } = useUnistyles();
    const machineName = useMachinePresenceSummary(props.serverId, props.machineId).name;
    const machineMark = React.useMemo(
        () => <Icon name="laptop" size={13} color={theme.colors.text.tertiary} />,
        [theme.colors.text.tertiary],
    );
    usePaneHeaderSlotContent(React.useMemo(() => ({
        line: {
            leading: machineMark,
            segments: [machineName
                ? t('browserLaunchpad.pane.previewsFrom', { machine: machineName })
                : t('browserLaunchpad.pane.previews')],
        },
    }), [machineMark, machineName]));
    return null;
}

/** The workspace publishes its machine label; the retained viewer owns its own chrome. */
export function BrowserSurfacePaneHeader(props: BrowserSurfacePaneHeaderProps): React.ReactElement | null {
    return props.presentation === 'viewer' ? null : <WorkspacePaneHeader {...props} />;
}
