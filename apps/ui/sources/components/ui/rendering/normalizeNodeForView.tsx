import * as React from 'react';

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

function isTextLikeIconElement(node: React.ReactElement): boolean {
    if (typeof node.type === 'string') return false;

    const props = (node.props ?? {}) as Record<string, unknown>;
    const hasIconLikeProps =
        typeof props.name === 'string'
        && (typeof props.size === 'number' || typeof props.size === 'string')
        && !('children' in props && props.children != null);

    return hasIconLikeProps;
}

export function normalizeNodeForView(node: React.ReactNode): React.ReactNode {
    if (node == null || typeof node === 'boolean') return null;
    if (typeof node === 'string' || typeof node === 'number') return wrapPrimitiveForView(node);
    if (Array.isArray(node)) return node.map((child) => normalizeNodeForView(child));
    if (React.isValidElement(node) && node.type === React.Fragment) {
        return <>{normalizeChildrenForView((node as any).props?.children)}</>;
    }
    if (React.isValidElement(node) && isTextLikeIconElement(node)) {
        return (
            <Text useDefaultTypography={false}>
                {node}
            </Text>
        );
    }
    if (React.isValidElement(node) && 'children' in ((node.props ?? {}) as Record<string, unknown>)) {
        return React.cloneElement(node, undefined, normalizeChildrenForView((node.props as any).children));
    }
    return node;
}
