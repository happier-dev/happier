import type * as React from 'react';
import type { View } from 'react-native';

import type { CommandMenuAnchor } from '@/components/ui/commandMenu';
import type { CaretRect } from '@/hooks/ui/textInputCaretRect';

export function resolveAgentInputCommandMenuAnchor(
    caretRect: CaretRect | null,
    fallbackRef: React.RefObject<View | null>,
): CommandMenuAnchor {
    if (caretRect !== null) {
        return {
            kind: 'rect',
            rect: {
                left: caretRect.left,
                top: caretRect.top,
                height: caretRect.height,
            },
            coordinateSpace: 'window',
        };
    }

    return { kind: 'view', ref: fallbackRef };
}

