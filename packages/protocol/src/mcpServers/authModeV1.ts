import type { McpServerCatalogEntryV1, McpValueRefV1 } from './settingsV1.js';

export type McpServerAuthModeV1 = 'none' | 'savedSecret' | 'machineEnv' | 'plainText';

function valueRefsFromServer(server: Pick<McpServerCatalogEntryV1, 'env' | 'remote'>): McpValueRefV1[] {
  const refs = Object.values(server.env ?? {});
  const headerRefs = Object.values(server.remote?.headers ?? {});
  return [...refs, ...headerRefs];
}

function isEnvironmentTemplateLiteral(value: string): boolean {
  return /\$\{[A-Z0-9_]+(?::[-=][^}]*)?\}/.test(value);
}

export function inferMcpServerAuthModeV1(server: Pick<McpServerCatalogEntryV1, 'env' | 'remote'>): McpServerAuthModeV1 {
  const refs = valueRefsFromServer(server);
  if (refs.length === 0) return 'none';

  if (refs.some((valueRef) => valueRef?.t === 'savedSecret')) {
    return 'savedSecret';
  }

  const literals = refs.filter((valueRef): valueRef is Extract<McpValueRefV1, { t: 'literal' }> => valueRef?.t === 'literal');
  if (literals.length === refs.length && literals.every((valueRef) => isEnvironmentTemplateLiteral(valueRef.v))) {
    return 'machineEnv';
  }

  return 'plainText';
}
