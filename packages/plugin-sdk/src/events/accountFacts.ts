export { MCP_SERVER_CATALOG_ACCOUNT_KEY_V1 } from '@happier-dev/protocol/mcp/servers/catalogIdentityV1';
import { ACCOUNT_JSON_KV_PREFIXES, classifyAccountJsonKvKey } from '@happier-dev/protocol/account/accountJsonKv';
export { buildTaskResourceChangeEntityIdV1, readTaskBlockerAddressV1, readTaskResourceChangeEntityIdV1 } from '@happier-dev/protocol/actions/internalTaskActions';

export function readTaskIdFromAccountKvKeyV1(key: string): string | null {
    if (key === 'todo.index' || classifyAccountJsonKvKey(key) !== 'todo') return null;
    return key.slice(ACCOUNT_JSON_KV_PREFIXES.todo.length);
}
