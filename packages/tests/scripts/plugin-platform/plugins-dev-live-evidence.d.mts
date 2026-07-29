export type PluginsDevChangeEnvelope =
  | Readonly<{
      ok: true;
      kind: 'plugins_dev_change';
      data: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      ok: false;
      kind: 'plugins_dev_change';
      error: Readonly<Record<string, unknown>>;
    }>;

export function parsePluginsDevChangeLine(line: string): PluginsDevChangeEnvelope | null;
