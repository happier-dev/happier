const ENGINE_NAMES: Readonly<Record<string, string>> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  sqlite: 'SQLite',
};

/** The engine as people name it ("PostgreSQL"), never its id; an engine a plugin adds keeps its own id. */
export function databaseEngineName(engine: string): string {
  return ENGINE_NAMES[engine] ?? engine;
}
