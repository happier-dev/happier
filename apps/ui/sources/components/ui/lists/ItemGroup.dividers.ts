import * as React from 'react';
import { ItemGroupRowPositionProvider } from './ItemGroupRowPosition';

type DividerChildProps = {
    showDivider?: boolean;
};

type FragmentProps = {
    children?: React.ReactNode;
};

export type ItemGroupVirtualizedSegment = Readonly<{
    first: boolean;
    last: boolean;
}>;

/**
 * Flattens an ItemGroup's children to the renderable element rows, splicing
 * fragments into the sequence and dropping primitives (whitespace/`0`) that
 * would otherwise become invalid `View` text nodes. Shared by both row-position
 * owners below so a fragment counts identically in either layout.
 */
export function flattenItemGroupElementChildren(node: React.ReactNode): React.ReactElement[] {
    return React.Children.toArray(node).reduce<React.ReactElement[]>((rows, child) => {
        if (!React.isValidElement(child)) return rows;
        if (child.type === React.Fragment) {
            const fragment = child as React.ReactElement<FragmentProps>;
            rows.push(...flattenItemGroupElementChildren(fragment.props.children));
            return rows;
        }
        rows.push(child);
        return rows;
    }, []);
}

export function withItemGroupDividers(
    children: React.ReactNode,
    virtualizedSegment?: ItemGroupVirtualizedSegment,
): React.ReactNode {
    const stripNonElementChildren = (node: React.ReactNode): React.ReactNode => {
        return React.Children.map(node, (child) => {
            if (!React.isValidElement(child)) {
                return null;
            }
            if (child.type === React.Fragment) {
                const fragment = child as React.ReactElement<FragmentProps>;
                return React.cloneElement(fragment, {}, stripNonElementChildren(fragment.props.children));
            }
            return child;
        });
    };

    const countNonFragmentElements = (node: React.ReactNode): number => {
        return React.Children.toArray(node).reduce<number>((count, child) => {
            if (!React.isValidElement(child)) {
                return count;
            }
            if (child.type === React.Fragment) {
                const fragment = child as React.ReactElement<FragmentProps>;
                return count + countNonFragmentElements(fragment.props.children);
            }
            return count + 1;
        }, 0);
    };

    const total = countNonFragmentElements(children);
    if (total === 0) return null;

    const elementChildren = stripNonElementChildren(children);

    let index = 0;
    const apply = (node: React.ReactNode): React.ReactNode => {
        return React.Children.map(node, (child) => {
            if (!React.isValidElement(child)) {
                return child;
            }
            if (child.type === React.Fragment) {
                const fragment = child as React.ReactElement<FragmentProps>;
                return React.cloneElement(fragment, {}, apply(fragment.props.children));
            }

            const isFirst = index === 0 && virtualizedSegment?.first !== false;
            const isLast = index === total - 1 && virtualizedSegment?.last !== false;
            index += 1;

            const element = child as React.ReactElement<DividerChildProps>;
            const showDivider = !isLast && element.props.showDivider !== false;
            const wrapperKey = element.key ?? `row-${index - 1}`;
            return React.createElement(
                ItemGroupRowPositionProvider,
                { key: wrapperKey as any, value: { isFirst, isLast } },
                React.cloneElement(element, { showDivider }),
            );
        });
    };

    return apply(elementChildren);
}
