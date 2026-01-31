import { dirname, join } from 'node:path';

const IDENTITY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function parseCliIdentityOrThrow(raw) {
  const v = (raw ?? '').toString().trim();
  if (!v || v === 'default') return 'default';
  if (!IDENTITY_RE.test(v)) {
    throw new Error(
      `[stack] invalid --identity=${JSON.stringify(v)}. ` +
        `Expected: "default" or a short name matching ${IDENTITY_RE} (max 64 chars).`
    );
  }
  return v;
}

export function resolveCliHomeDirForIdentity({ cliHomeDir, identity }) {
  const id = parseCliIdentityOrThrow(identity);
  if (id === 'default') return cliHomeDir;

  // Keep identities adjacent to the stack's default cli home dir:
  //   <...>/<stack>/cli              (default)
  //   <...>/<stack>/cli-identities/<id>
  //
  // If the stack overrides cliHomeDir to a custom path, we keep the same layout
  // relative to that path's parent directory.
  const baseDir = dirname(cliHomeDir);
  return join(baseDir, 'cli-identities', id);
}
