/**
 * Canonical slash-command name normalization (plan G1/D2).
 *
 * A provider advertises its supported slash commands through the runtime `slash_commands` list (e.g.
 * Claude's system/init record, mirrored onto `metadata.slashCommands`). The shapes are inconsistent
 * about the leading slash: some runtimes emit `goal`, others `/goal`. Before this helper the CLI goal
 * source and the UI capability gate each did a raw `slashCommands.includes('goal')`, which silently
 * missed the `/goal` shape and duplicated the parsing rule across two layers.
 *
 * This is the ONE place that turns a raw `slash_commands` value into normalized command names. Both
 * the plugin runtime source gate and the generic UI session-capability gate consume it so the
 * `goal`/`/goal` parity is defined once and cannot drift. It is intentionally provider-agnostic — the
 * normalization rules (strip a single leading slash, lowercase, trim) are generic slash-command
 * mechanics, not provider business logic — so it can sit in a provider-agnostic capability check.
 *
 * Normalization rules (fail-closed):
 *  - accept strings only;
 *  - trim surrounding whitespace;
 *  - lowercase;
 *  - strip a SINGLE leading `/` (so `//goal` stays `/goal`, not `goal`);
 *  - reject empty / slash-only / non-string values.
 */

export function normalizeSlashCommandName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  const withoutLeadingSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  return withoutLeadingSlash.length > 0 ? withoutLeadingSlash : null;
}

/**
 * Read the normalized command name from the first token of a user prompt.
 *
 * This deliberately recognizes only a single leading slash. Host-owned syntax
 * such as `//...` and slashes embedded in ordinary prose are not provider
 * commands.
 */
export function readLeadingSlashCommandName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trimStart();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  const [token] = trimmed.split(/\s/u, 1);
  return normalizeSlashCommandName(token);
}

/**
 * Normalize a raw `slash_commands` value into the list of supported command names. Returns an empty
 * list for any non-array (fail-closed) and drops every malformed entry.
 */
export function readSlashCommandNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    const normalized = normalizeSlashCommandName(entry);
    if (normalized) names.push(normalized);
  }
  return names;
}

/**
 * Whether the runtime `slash_commands` list advertises `commandName`. Both the list entries and the
 * queried name are normalized, so `goal` and `/goal` match either way. Fail-closed: a non-array list
 * or an unparsable query name is treated as unsupported.
 */
export function isSlashCommandSupported(slashCommands: unknown, commandName: string): boolean {
  const target = normalizeSlashCommandName(commandName);
  if (!target) return false;
  return readSlashCommandNames(slashCommands).includes(target);
}
