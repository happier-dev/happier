import * as React from 'react';

import { PopoverBoundaryProvider } from './PopoverBoundary';
import { PopoverPortalTargetProvider } from './PopoverPortalTargetProvider';
import { PopoverScrollSourceProvider } from './PopoverScrollSource';

export type PopoverScopeProps = Readonly<{
    children: React.ReactNode;
    boundaryRef?: React.RefObject<any> | null;
    scrollSourceRef?: React.RefObject<any> | null;
}>;

export function PopoverScope(props: PopoverScopeProps) {
    let content = props.children;

    if (props.boundaryRef) {
        content = (
            <PopoverBoundaryProvider boundaryRef={props.boundaryRef}>
                {content}
            </PopoverBoundaryProvider>
        );
    }

    if (props.scrollSourceRef) {
        content = (
            <PopoverScrollSourceProvider scrollSourceRef={props.scrollSourceRef}>
                {content}
            </PopoverScrollSourceProvider>
        );
    }

    return (
        <PopoverPortalTargetProvider>
            {content}
        </PopoverPortalTargetProvider>
    );
}

