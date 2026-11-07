import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';
import { listValueRefSecretIdsV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';
import { machinePageHref } from '@/components/machines/page/machinePageHref';

export type McpRecoveryEditor = Readonly<{
  kind: 'env' | 'header'; initialKey: string; initialValueRef: ValueRefV1;
  onSubmit: (value: Readonly<{ key: string; valueRef: ValueRefV1 }>) => boolean;
}>;
export type McpServerRecovery = Readonly<{ addKey(): void; useApiKey(): void; howToFix(machineId: string): void }>;

/** Saved-detail recovery intents; presentation stays in the existing ValueRef modal and machine Tools page. */
export function createMcpServerRecovery(input: Readonly<{
  server: McpServerCatalogEntryV1;
  missingKeys: ReadonlySet<string>;
  isMissingReference: (ref: string) => boolean;
  scopeServerId?: string;
  onChangeServer: (update: (server: McpServerCatalogEntryV1) => McpServerCatalogEntryV1) => void;
  onCommit: () => void;
  openEditor: (editor: McpRecoveryEditor) => void;
  openRoute: (route: string) => void;
}>): McpServerRecovery {
  function edit(kind: 'env' | 'header', key: string, ref: ValueRefV1, apiKey = false) {
    const variable = ref.t === 'template'
      ? Object.entries(ref.vars).find(([, value]) => value.t === 'savedSecret' && input.isMissingReference(value.secretId))?.[0]
      : undefined;
    input.openEditor({ kind, initialKey: key, initialValueRef: variable && ref.t === 'template'
      ? ref.vars[variable]! : apiKey ? { t: 'savedSecret', secretId: '' } : ref,
      onSubmit: ({ key: nextKey, valueRef }) => {
        if (nextKey !== key || ((variable || apiKey) && valueRef.t !== 'literal' && valueRef.t !== 'savedSecret')) return false;
        input.onChangeServer(current => {
          const existing = kind === 'env' ? current.env[key] : current.remote?.headers[key];
          const next: ValueRefV1 = variable && existing?.t === 'template' && (valueRef.t === 'literal' || valueRef.t === 'savedSecret')
            ? { ...existing, vars: { ...existing.vars, [variable]: valueRef } }
            : apiKey && key.toLowerCase() === 'authorization' && (valueRef.t === 'literal' || valueRef.t === 'savedSecret')
              ? { t: 'template', template: 'Bearer {api_key}', vars: { api_key: valueRef } } : valueRef;
          if (kind === 'env') return { ...current, env: { ...current.env, [key]: next }, updatedAt: Date.now() };
          if (!current.remote) return current;
          const { auth, ...remote } = current.remote;
          return { ...current, remote: { ...remote, ...(!apiKey && auth ? { auth } : {}), headers: { ...remote.headers, [key]: next } }, updatedAt: Date.now() };
        });
        input.onCommit();
        return true;
      },
    });
  }
  return {
    addKey: () => {
      for (const kind of ['env', 'header'] as const) {
        const entries = kind === 'env' ? input.server.env : input.server.remote?.headers ?? {};
        const row = Object.entries(entries).find(([key, value]) => input.missingKeys.has(key) && listValueRefSecretIdsV1(value).some(input.isMissingReference));
        if (row) { edit(kind, row[0], row[1]); return; }
      }
    },
    useApiKey: () => {
      const headers = input.server.remote?.headers;
      if (!headers) return;
      const key = Object.keys(headers).find(key => key.toLowerCase() === 'authorization') ?? 'Authorization';
      edit('header', key, headers[key] ?? { t: 'literal', v: '' }, true);
    },
    howToFix: machineId => input.openRoute(machinePageHref({ door: 'rail', target: { machineId, serverId: input.scopeServerId }, tab: { id: 'setup', page: 'tools' } })),
  };
}
