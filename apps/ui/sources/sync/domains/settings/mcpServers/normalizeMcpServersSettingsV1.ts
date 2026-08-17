import {
    McpServersSettingsV1Schema,
    type McpServersSettingsV1,
} from '@happier-dev/protocol';

const EMPTY_MCP_SERVERS_SETTINGS_V1 = McpServersSettingsV1Schema.parse({});

function hasEqualJsonShape(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
        return false;
    }

    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        return left.every((value, index) => hasEqualJsonShape(value, right[index]));
    }

    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => (
        Object.hasOwn(rightRecord, key)
        && hasEqualJsonShape(leftRecord[key], rightRecord[key])
    ));
}

/**
 * Account settings retain MCP data as bounded legacy JSON. This is the sole
 * UI ingress into the current MCP schema; malformed or future-only data must
 * not become executable MCP configuration.
 */
export function normalizeMcpServersSettingsV1(raw: unknown): McpServersSettingsV1 {
    const parsed = McpServersSettingsV1Schema.safeParse(raw);
    if (!parsed.success) return EMPTY_MCP_SERVERS_SETTINGS_V1;

    const settings = parsed.data;
    const serverIds = new Set(settings.servers.map((s) => s.id));
    const filteredBindings = settings.bindings.filter((b) => serverIds.has(b.serverId));
    if (filteredBindings.length === settings.bindings.length) {
        return settings;
    }
    return { ...settings, bindings: filteredBindings };
}

/**
 * Returns a current settings value only when normalization would preserve the
 * retained Account root exactly. Display readers may normalize legacy data,
 * but whole-root mutations must not strip unknown or malformed data.
 */
export function readWritableMcpServersSettingsV1(raw: unknown): McpServersSettingsV1 | null {
    const parsed = McpServersSettingsV1Schema.safeParse(raw);
    if (!parsed.success) return null;

    const normalized = normalizeMcpServersSettingsV1(raw);
    return hasEqualJsonShape(raw, normalized) ? normalized : null;
}
