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
    /** A page is open: the page and its address lead, so the large header steps aside (lab Qp vs Lp). */
    pageOpen?: boolean;
}>;

function WorkspacePaneHeader(props: BrowserSurfacePaneHeaderProps): null {
    const { theme } = useUnistyles();
    const machineName = useMachinePresenceSummary(props.serverId, props.machineId).name;
    const machineMark = React.useMemo(
        () => <Icon name="laptop" size={13} color={theme.colors.text.tertiary} />,
        [theme.colors.text.tertiary],
    );
    // "Previews from" describes the launchpad's list; over an open page (a website, often) the line names only
    // where the browser runs. A phone never draws the large header over the Browser: the Session header and the
    // address carry identity, and the page or the launchpad starts right under them (labs Kp, Ap).
    const segment = props.pageOpen === true
        ? machineName ?? null
        : machineName ? t('browserLaunchpad.pane.previewsFrom', { machine: machineName }) : t('browserLaunchpad.pane.previews');
    usePaneHeaderSlotContent(React.useMemo(() => ({
        line: { leading: machineMark, segments: segment ? [segment] : [] },
        immersive: true,
    }), [machineMark, segment]));
    return null;
}

/** The workspace publishes its machine label; the retained viewer owns its own chrome. */
export function BrowserSurfacePaneHeader(props: BrowserSurfacePaneHeaderProps): React.ReactElement | null {
    return props.presentation === 'viewer' ? null : <WorkspacePaneHeader {...props} />;
}
