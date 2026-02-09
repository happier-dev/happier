import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import type { ToolViewProps } from '@/components/tools/renderers/core/_registry';

export function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
    const now = Date.now();
    return {
        name: 'UnknownTool',
        state: 'completed',
        input: {},
        result: null,
        createdAt: now,
        startedAt: now,
        completedAt: now,
        description: null,
        permission: undefined,
        ...overrides,
    };
}

export function collectHostText(tree: ReactTestRenderer): string[] {
    return tree.root
        .findAllByType('Text')
        .flatMap((node) => flattenTextValue((node.props as { children?: unknown }).children));
}

export function collectNodeText(node: ReactTestInstance): string[] {
    return flattenTextValue((node.props as { children?: unknown }).children);
}

export function findPressableByText(
    tree: ReactTestRenderer,
    text: string,
    hostTypes: ReadonlyArray<string> = ['TouchableOpacity', 'Pressable'],
): ReactTestInstance | undefined {
    for (const hostType of hostTypes) {
        const nodes = tree.root.findAllByType(hostType);
        for (const node of nodes) {
            const nestedText = node.findAllByType('Text').flatMap((textNode) => collectNodeText(textNode)).join(' ');
            if (nestedText.includes(text)) {
                return node;
            }
        }
    }
    return undefined;
}

export function makeToolViewProps(
    tool: ToolCall,
    overrides: Partial<ToolViewProps> = {},
): ToolViewProps {
    return {
        tool,
        metadata: null,
        messages: [],
        ...overrides,
    };
}

function flattenTextValue(value: unknown): string[] {
    if (typeof value === 'string') {
        return [value];
    }
    if (typeof value === 'number') {
        return [String(value)];
    }
    if (Array.isArray(value)) {
        return value.flatMap((item) => flattenTextValue(item));
    }
    return [];
}
