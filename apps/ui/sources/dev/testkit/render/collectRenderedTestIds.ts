import type { ReactTestRendererJSON } from 'react-test-renderer';

export function collectRenderedTestIds(
    node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null,
    output: string[] = [],
): string[] {
    if (node == null || typeof node === 'string') return output;
    if (Array.isArray(node)) {
        for (const child of node) collectRenderedTestIds(child, output);
        return output;
    }

    if (typeof node.props?.testID === 'string') output.push(node.props.testID);
    for (const child of node.children ?? []) collectRenderedTestIds(child, output);
    return output;
}
