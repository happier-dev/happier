import React from 'react';
import { View } from 'react-native';

import type {
    TreeDropMeasurableRef,
    TreeInstructionVisual,
} from '@/components/ui/treeDragDrop';
import { SessionListDropIndicator } from './SessionListDropIndicator';

export type RegisterSessionListTreeRowBounds = (rowId: string, ref: TreeDropMeasurableRef | null) => void;
export type UnregisterSessionListTreeRowBounds = (rowId: string) => void;

export const SessionListHeaderFrame = React.memo(function SessionListHeaderFrame(props: Readonly<{
    children: React.ReactNode;
    treeRowId: string;
    activeDropVisual: TreeInstructionVisual;
    onRegisterTreeRowBounds: RegisterSessionListTreeRowBounds;
    onUnregisterTreeRowBounds: UnregisterSessionListTreeRowBounds;
}>) {
    const wrapperRef = React.useRef<View>(null);
    React.useEffect(() => {
        return () => {
            props.onUnregisterTreeRowBounds(props.treeRowId);
        };
    }, [props.onUnregisterTreeRowBounds, props.treeRowId]);
    return (
        <View
            ref={wrapperRef}
            collapsable={false}
            style={{ position: 'relative' }}
            onLayout={() => props.onRegisterTreeRowBounds(props.treeRowId, wrapperRef.current)}
        >
            <SessionListDropIndicator
                targetId={props.treeRowId}
                visual={props.activeDropVisual}
            />
            {props.children}
        </View>
    );
});
