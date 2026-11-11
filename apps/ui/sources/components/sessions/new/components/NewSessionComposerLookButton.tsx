import * as React from 'react';
import { View } from 'react-native';

import { LookPopover, type LookTarget } from '@/components/atmosphere/look/LookChip';
import { AGENT_INPUT_QUIET_ICON_SIZE_PX } from '@/components/sessions/agentInput/components/agentInputChromeStyles';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { t } from '@/text';

import { useStatusRowIconHitEdges } from '@/components/sessions/agentInput/instrumentStrip/useStatusRowIconHitEdges';

/** Look for the bottom-anchored floating composer: the row's quiet icon, opening the shared Look panel. */
export const NewSessionComposerLookButton = React.memo(function NewSessionComposerLookButton(
    props: Readonly<{ target: LookTarget; testID?: string }>,
): React.ReactElement {
    const edges = useStatusRowIconHitEdges();
    const anchorRef = React.useRef<View | null>(null);
    const [open, setOpen] = React.useState(false);
    const close = React.useCallback(() => setOpen(false), []);
    const label = t('settingsAppearance.glassControls.look');
    return (
        <View ref={anchorRef} collapsable={false}>
            <IconButton testID={props.testID} variant="plain" iconName="palette" tooltipPlacement="top"
                size={AGENT_INPUT_QUIET_ICON_SIZE_PX} interactiveTargetEdgesPx={edges}
                accessibilityLabel={label} tooltip={open ? undefined : label} selected={open} expanded={open}
                onPress={() => setOpen(!open)} />
            <LookPopover target={props.target} open={open} anchorRef={anchorRef} onRequestClose={close} />
        </View>
    );
});
