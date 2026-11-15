import * as React from 'react';
import type { View } from 'react-native';
import { AtmosphereSurfaceFrame } from './AtmosphereSurfaceFrame';
import { LookChip, LookPopover, type LookTarget } from './look/LookChip';
import { useProjectAtmosphereEditor } from './look/useProjectAtmosphereEditor';

const ProjectLook = React.createContext<LookTarget | null>(null);
export function ProjectAtmosphereFrame(props: Readonly<{
    project: Readonly<{ serverId: string; projectKey: string }>;
    focused?: boolean;
    column?: React.RefObject<View | null>;
    children: React.ReactNode;
}>) {
    const editor = useProjectAtmosphereEditor(props.project);
    const target = React.useMemo(() => ({ surface: { project: props.project }, editor }), [editor, props.project]);
    return <ProjectLook.Provider value={target}>
        <AtmosphereSurfaceFrame surface={target.surface} editor={editor} focused={props.focused} column={props.column}>
            {props.children}
        </AtmosphereSurfaceFrame>
    </ProjectLook.Provider>;
}
export function ProjectAtmosphereLookChip() {
    const target = React.useContext(ProjectLook);
    return target ? <LookChip target={target} testID="project-look" /> : null;
}

/**
 * The Project's Look panel opened from another control (a phone head's ⋯), outside the frame's tree. Mount it
 * only while open: its editor reads the same Project row and writes through the same Settings Action.
 */
export function ProjectLookPopover(props: Readonly<{
    project: Readonly<{ serverId: string; projectKey: string }>;
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
}>) {
    const editor = useProjectAtmosphereEditor(props.project);
    const target = React.useMemo(() => ({ surface: { project: props.project }, editor }), [editor, props.project]);
    return <LookPopover open target={target} anchorRef={props.anchorRef} onRequestClose={props.onRequestClose} />;
}
