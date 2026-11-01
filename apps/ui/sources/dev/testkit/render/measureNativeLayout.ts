import type { ReactTestInstance } from 'react-test-renderer';
import Yoga, { type Node } from 'yoga-layout';

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    if (!style || typeof style !== 'object') {
        return {};
    }
    return style as Record<string, unknown>;
}

// Yoga exercises the rendered flex tree. Only OS text measurement is substituted;
// title, metadata, and action allocation all use the component's actual styles.
export function measureNativeLayout(root: ReactTestInstance, width: number, textScale: number, height?: number) {
    const config = Yoga.Config.create();
    // Compare logical bounds without Yoga's per-node rounding to whole device pixels.
    config.setPointScaleFactor(0);
    const nodes = new Map<ReactTestInstance, Node>();
    function build(instance: ReactTestInstance): Node {
        const node = Yoga.Node.createWithConfig(config);
        nodes.set(instance, node);
        const style = flattenStyle(instance.props.style);
        if (style.position === 'absolute') node.setPositionType(Yoga.POSITION_TYPE_ABSOLUTE);
        if (style.flexDirection === 'row') node.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
        if (style.alignItems === 'center') node.setAlignItems(Yoga.ALIGN_CENTER);
        if (style.alignItems === 'flex-start') node.setAlignItems(Yoga.ALIGN_FLEX_START);
        if (style.justifyContent === 'center') node.setJustifyContent(Yoga.JUSTIFY_CENTER);
        if (typeof style.flex === 'number') node.setFlex(style.flex);
        if (typeof style.flexShrink === 'number') node.setFlexShrink(style.flexShrink);
        if (typeof style.minWidth === 'number') node.setMinWidth(style.minWidth);
        if (typeof style.minHeight === 'number') node.setMinHeight(style.minHeight);
        if (typeof style.width === 'number' || style.width === '100%') node.setWidth(style.width);
        if (typeof style.height === 'number') node.setHeight(style.height);
        if (typeof style.maxWidth === 'number' || style.maxWidth === '100%') node.setMaxWidth(style.maxWidth);
        if (typeof style.gap === 'number') node.setGap(Yoga.GUTTER_ALL, style.gap);
        for (const [key, edge] of [
            ['paddingHorizontal', Yoga.EDGE_HORIZONTAL], ['paddingVertical', Yoga.EDGE_VERTICAL],
            ['paddingTop', Yoga.EDGE_TOP], ['paddingBottom', Yoga.EDGE_BOTTOM],
        ] as const) {
            if (typeof style[key] === 'number') node.setPadding(edge, style[key]);
        }
        if (typeof style.marginRight === 'number') node.setMargin(Yoga.EDGE_RIGHT, style.marginRight);
        if (typeof style.marginTop === 'number') node.setMargin(Yoga.EDGE_TOP, style.marginTop);
        if (String(instance.type) === 'Text') {
            const fontSize = Number(style.fontSize ?? 12) * textScale;
            const intrinsicWidth = instance.children.join('').length * fontSize * 0.6;
            const height = Number(style.lineHeight ?? Number(style.fontSize ?? 12) * 1.2) * textScale;
            node.setMeasureFunc((available, mode) => ({
                width: mode === Yoga.MEASURE_MODE_UNDEFINED ? intrinsicWidth : Math.min(intrinsicWidth, available),
                height,
            }));
        } else if (String(instance.type) === 'Avatar' || String(instance.type) === 'AgentIcon') {
            node.setWidth(instance.props.size);
            node.setHeight(instance.props.size);
        } else {
            const children = instance.children.flatMap((child) => typeof child === 'string'
                ? []
                : child.findAll((entry) => typeof entry.type === 'string', { deep: false }));
            for (const child of children) {
                node.insertChild(build(child), node.getChildCount());
            }
        }
        return node;
    }
    const layout = build(root);
    layout.calculateLayout(width, height, Yoga.DIRECTION_LTR);
    return {
        rect(instance: ReactTestInstance) {
            const node = nodes.get(instance);
            if (!node) throw new Error(`Unmeasured header node: ${String(instance.type)}`);
            let left = node.getComputedLeft();
            let top = node.getComputedTop();
            for (let parent = node.getParent(); parent; parent = parent.getParent()) {
                left += parent.getComputedLeft();
                top += parent.getComputedTop();
            }
            return { left, top, width: node.getComputedWidth(), height: node.getComputedHeight() };
        },
        free: () => { layout.freeRecursive(); config.free(); },
    };
}
