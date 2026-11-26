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

/**
 * One fact line under a database's name: its engine and where it lives. The page header, the rail tab's picker rows,
 * read setup and the Dev servers row all say it from here.
 */
export function databaseFacts(descriptor: Readonly<{ engine: string; origin: Readonly<{ label: string; environmentName?: string }> }>): string {
  return [databaseEngineName(descriptor.engine), databaseOriginName(descriptor.origin)]
    .filter(Boolean)
    .join(' · ');
}
