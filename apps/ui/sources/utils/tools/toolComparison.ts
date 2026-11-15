import { sameJsonValue } from '@/utils/json/sameJsonValue';

/**
 * Deep comparison utility for tool calls
 * Compares tool name and arguments to determine if two tool calls are the same
 */
export function compareToolCalls(
    tool1: { name: string; arguments: unknown },
    tool2: { name: string; arguments: unknown }
): boolean {
    // Compare tool names (case-sensitive)
    if (tool1.name !== tool2.name) {
        return false;
    }

    // Compare arguments using deep equality
    return sameJsonValue(tool1.arguments, tool2.arguments);
}
