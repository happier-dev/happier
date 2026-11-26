const ENGINE_NAMES: Readonly<Record<string, string>> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  sqlite: 'SQLite',
};

/** The engine as people name it ("PostgreSQL"), never its id; an engine a plugin adds keeps its own id. */
export function databaseEngineName(engine: string): string {
  return ENGINE_NAMES[engine] ?? engine;
}

/** Where a database lives, as people name it: its admitted Environment when the origin names only the managed provider. */
export function databaseOriginName(origin: Readonly<{ label: string; environmentName?: string }>): string {
  return origin.environmentName ?? origin.label;
}
