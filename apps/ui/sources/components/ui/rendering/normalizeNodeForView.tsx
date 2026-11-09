import * as React from 'react';

import { isRenderableElementType } from '@/components/ui/icons/isRenderableElementType';
import { Text } from '@/components/ui/text/Text';

function wrapPrimitiveForView(value: string | number) {
    return (
        <Text useDefaultTypography={false}>
            {String(value)}
        </Text>
    );
}

function normalizeChildrenForView(children: React.ReactNode): React.ReactNode {
    return React.Children.map(children, (child) => normalizeNodeForView(child));
}

export function normalizeNodeForView(node: React.ReactNode): React.ReactNode {
    if (node == null || typeof node === 'boolean') return null;
    if (typeof node === 'string' || typeof node === 'number') return wrapPrimitiveForView(node);
    if (Array.isArray(node)) return node.map((child) => normalizeNodeForView(child));
    if (React.isValidElement(node) && node.type === React.Fragment) {
        return <>{normalizeChildrenForView((node as any).props?.children)}</>;
    }
    if (React.isValidElement(node) && !isRenderableElementType(node.type)) {
        return null;
    }
    // Only bare strings and numbers need a Text. Icons pass through as they are: the app Icon draws an SVG view and
    // a font icon renders its own Text, while a Text wrapper would set either on a line box, a pixel or two above
    // the centre of the row it sits in (composer chips, menu rows).
    if (React.isValidElement(node) && 'children' in ((node.props ?? {}) as Record<string, unknown>)) {
        const rawChildren = (node.props as { children?: React.ReactNode }).children;
        // Preserve a SINGLE child as a single node. `React.Children.map` always
        // returns an array (even for one child), which would make strict
        // single-child consumers throw — notably RNGH's `GestureDetector` web
        // wrapper, which calls `React.Children.only(children)`. Only fan the
        // children out when there genuinely is more than one.
        const normalizedChildren = Array.isArray(rawChildren)
            ? normalizeChildrenForView(rawChildren)
            : normalizeNodeForView(rawChildren);
        return React.cloneElement(node, undefined, normalizedChildren);
    }
    return node;
}
