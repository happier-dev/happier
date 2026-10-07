import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';

import type { MachineAgentPickerPlacement } from './machineAgentPresentation';

/**
 * The engine rail's state mark for an agent that isn't simply ready on the composer's machine: a download
 * glyph (not installed), a warning dot (needs sign-in), a loading mark (installing), a failure glyph, or
 * the "can't run here" glyph. Quiet colours except trouble.
 */
export const MachineAgentPickerMarker = React.memo(function MachineAgentPickerMarker(props: Readonly<{
    marker: MachineAgentPickerPlacement['marker'];
}>) {
    const { theme } = useUnistyles();
    switch (props.marker) {
        case 'download': return <Icon name="download" size={14} color={theme.colors.text.tertiary} />;
        case 'needsSignIn': return <StatusDot size={7} color={theme.colors.state.warning.foreground} />;
        case 'installing': return <ActivitySpinner size={14} color={theme.colors.text.tertiary} style={{ width: 14, height: 14 }} />;
        case 'failed': return <Icon name="warning-circle" size={14} color={theme.colors.state.danger.foreground} />;
        case 'unsupported': return <Icon name="minus-circle" size={14} color={theme.colors.text.tertiary} />;
        case 'none': return null;
    }
});
