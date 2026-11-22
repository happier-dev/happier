import React from 'react';
import { View } from 'react-native';

import type { TreeDropMeasurableRef } from '@/components/ui/treeDragDrop';
import { useSessionListTreeRowRegistration } from './useSessionListTreeRowRegistration';

export type RegisterSessionListTreeRowBounds = (rowId: string, ref: TreeDropMeasurableRef | null) => void;
export type UnregisterSessionListTreeRowBounds = (rowId: string) => void;

/**
 * Static frame around a non-draggable section header.
 *
 * Phase 3 of the session-list drag geometry & performance unification: the
 * frame no longer renders a row-local drop indicator and no longer receives an
 * `activeDropVisual`. The single list-level `SessionListDropOverlay` owns the
 * indicator. The frame still registers its content bounds on layout so the
 * pointer can hit-test against it.
 */
export const SessionListHeaderFrame = React.memo(function SessionListHeaderFrame(props: Readonly<{
    children: React.ReactNode;
    treeRowId: string;
    onRegisterTreeRowBounds: RegisterSessionListTreeRowBounds;
    onUnregisterTreeRowBounds: UnregisterSessionListTreeRowBounds;
}>) {
    const { setWrapperRef, handleLayout } = useSessionListTreeRowRegistration(
        props.treeRowId, props.onRegisterTreeRowBounds, props.onUnregisterTreeRowBounds,
    );
    return (
        <View
            ref={setWrapperRef}
            collapsable={false}
            style={{ position: 'relative' }}
            onLayout={handleLayout}
        >
            {props.children}
        </View>
    );
});
