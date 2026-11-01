import fs from 'node:fs';

/**
 * Equivalence check for installed daemon service definitions.
 * Systemd units compare strictly except for the inherited PATH value; launchd
 * plists use the semantic signature below.
 *
 * Background: the previous raw-file-equality check (`installed.trim() ===
 * expected.trim()`) reported spurious drift because the expected content is
 * regenerated on every invocation using the caller's `process.env.PATH`,
 * which includes ephemeral segments like `fnm_multishells/<pid>_<ts>/bin`
 * and cwd-derived `node_modules/.bin`. It also kept flagging drift when the
 * installed plist used the `[node, entry, daemon, start-sync]` ProgramArguments
 * form while the current plan-builder produces the semantically-equivalent
 * `[shim, daemon, start-sync]` form.
 *
 * This comparator extracts only the fields that materially determine runtime
 * behavior and compares those. It intentionally ignores `PATH` and normalises
 * ProgramArguments so shim/node+entry forms are treated as equivalent as long
 * as the Happier env vars (which govern what actually runs) match.
 *
 * Returns true when both definitions would launch the same daemon under the
 * same Happier home, channel, and target mode — i.e. no meaningful drift.
 */
export function doesInstalledDaemonServiceDefinitionMatchExpected(params: Readonly<{
  installedPath: string;
  expectedContents: string;
}>): boolean {
  let installedRaw: string;
  try {
    installedRaw = fs.readFileSync(params.installedPath, 'utf-8');
  } catch {
    return false;
  }

  // Fast-path: exact byte-equal (post-trim). Cheap win for freshly-installed
  // services where nothing has drifted yet.
  if (installedRaw.trim() === params.expectedContents.trim()) return true;

  const installedSystemd = normalizeSystemdServicePath(installedRaw);
  const expectedSystemd = normalizeSystemdServicePath(params.expectedContents);
  if (installedSystemd !== null && expectedSystemd !== null) {
    return installedSystemd === expectedSystemd;
  }

  const installed = extractPlistSignature(installedRaw);
  const expected = extractPlistSignature(params.expectedContents);
  if (!installed || !expected) return false;
  return compareServiceSignatures(installed, expected);
}

function normalizeSystemdServicePath(contents: string): string | null {
  let section = '';
  let hasServiceSection = false;
  const lines = contents.trim().split('\n').map((line) => {
    if (/^\[[^\]]+\]$/.test(line)) {
      section = line;
      if (section === '[Service]') hasServiceSection = true;
    }
    // Match only the standalone assignment emitted by renderSystemdServiceUnit,
    // including its escaped quoted form. Do not hide other assignments or a
    // missing PATH, and keep every other directive byte-for-byte comparable.
    if (section === '[Service]' && /^Environment=PATH=(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_./:@%+-]+)$/.test(line)) {
      return 'Environment=PATH=';
    }
    return line;
  });
  return hasServiceSection ? lines.join('\n') : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Extracted signature comparison
// ─────────────────────────────────────────────────────────────────────────

type PlistSignature = Readonly<{
  label: string;
  programArguments: readonly string[];
  env: Readonly<Record<string, string>>;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
}>;

function compareServiceSignatures(a: PlistSignature, b: PlistSignature): boolean {
  if (a.label !== b.label) return false;
  if (a.workingDirectory !== b.workingDirectory) return false;
  if (a.stdoutPath !== b.stdoutPath) return false;
  if (a.stderrPath !== b.stderrPath) return false;
  if (!compareProgramArgumentsSemantically(a.programArguments, b.programArguments)) return false;
  // Drop PATH from both sides — it is populated from the caller's environment
  // and drifts per invocation (fnm shells, cwd node_modules/.bin cascades).
  const aEnv = stripNoiseEnvKeys(a.env);
  const bEnv = stripNoiseEnvKeys(b.env);
  return shallowEqualStringMap(aEnv, bEnv);
}

const NOISE_ENV_KEYS = new Set(['PATH']);

function stripNoiseEnvKeys(env: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (NOISE_ENV_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function shallowEqualStringMap(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * Two ProgramArguments arrays are semantically equivalent if they launch the
 * same CLI with the same trailing args. Three canonical shapes:
 *   - `[shim, 'daemon', 'start-sync']`              (shim form)
 *   - `[node, entry.mjs, 'daemon', 'start-sync']`    (node + entry form)
 *   - Future/legacy variants that still end in the same trailing args.
 *
 * We consider them equivalent when the trailing args match. The leading
 * launcher differs (shim vs node+entry), but the daemon reads its behavior
 * from the env vars (HAPPIER_HOME_DIR + HAPPIER_PUBLIC_RELEASE_CHANNEL +
 * HAPPIER_DAEMON_SERVICE_TARGET_MODE), which ARE compared strictly below.
 * Since those env vars pin the CLI install + channel + mode, a drifted
 * launcher path still ends up running the same daemon under the same config.
 */
function compareProgramArgumentsSemantically(a: readonly string[], b: readonly string[]): boolean {
  const aTrailing = trailingCommandArgs(a);
  const bTrailing = trailingCommandArgs(b);
  if (aTrailing.length !== bTrailing.length) return false;
  for (let i = 0; i < aTrailing.length; i++) {
    if (aTrailing[i] !== bTrailing[i]) return false;
  }
  return true;
}

function trailingCommandArgs(args: readonly string[]): readonly string[] {
  // Locate the `daemon` subcommand — everything from there on is the trailing
  // command. This is robust to both `[shim, daemon, start-sync]` and
  // `[node, entry, daemon, start-sync]` shapes.
  const daemonIndex = args.indexOf('daemon');
  if (daemonIndex >= 0) return args.slice(daemonIndex);
  // No `daemon` token found — fall back to comparing the whole array so a
  // genuinely different service shape still flags as drift.
  return args;
}

// ─────────────────────────────────────────────────────────────────────────
// Plist extraction (regex-based — the plist template is ours; narrowly scoped)
// ─────────────────────────────────────────────────────────────────────────

function extractPlistSignature(plistXml: string): PlistSignature | null {
  const label = extractPlistStringValue(plistXml, 'Label');
  if (!label) return null;
  const programArguments = extractPlistArrayStrings(plistXml, 'ProgramArguments');
  if (programArguments.length === 0) return null;
  return {
    label,
    programArguments,
    env: extractPlistDictStrings(plistXml, 'EnvironmentVariables'),
    workingDirectory: extractPlistStringValue(plistXml, 'WorkingDirectory') ?? '',
    stdoutPath: extractPlistStringValue(plistXml, 'StandardOutPath') ?? '',
    stderrPath: extractPlistStringValue(plistXml, 'StandardErrorPath') ?? '',
  };
}

function extractPlistStringValue(plistXml: string, key: string): string | null {
  const pattern = new RegExp(`<key>${escapeRegex(key)}</key>\\s*<string>([\\s\\S]*?)</string>`);
  const match = plistXml.match(pattern);
  return match ? decodePlistString(match[1]) : null;
}

function extractPlistArrayStrings(plistXml: string, key: string): readonly string[] {
  const pattern = new RegExp(`<key>${escapeRegex(key)}</key>\\s*<array>([\\s\\S]*?)</array>`);
  const match = plistXml.match(pattern);
  if (!match) return [];
  const arrayBody = match[1];
  const strings: string[] = [];
  const stringPattern = /<string>([\s\S]*?)<\/string>/g;
  let m: RegExpExecArray | null;
  while ((m = stringPattern.exec(arrayBody)) !== null) {
    strings.push(decodePlistString(m[1]));
  }
  return strings;
}

function extractPlistDictStrings(plistXml: string, key: string): Readonly<Record<string, string>> {
  const pattern = new RegExp(`<key>${escapeRegex(key)}</key>\\s*<dict>([\\s\\S]*?)</dict>`);
  const match = plistXml.match(pattern);
  if (!match) return {};
  const dictBody = match[1];
  // Pairs are <key>K</key><string>V</string>. We accept `<true/>`/`<false/>`
  // for completeness too, stringifying as 'true'/'false'. Non-string values
  // in Happier service plists are rare, but we shouldn't crash if encountered.
  const out: Record<string, string> = {};
  const pairPattern = /<key>([\s\S]*?)<\/key>\s*(?:<string>([\s\S]*?)<\/string>|<(true|false)\s*\/>)/g;
  let m: RegExpExecArray | null;
  while ((m = pairPattern.exec(dictBody)) !== null) {
    const k = decodePlistString(m[1]);
    const v = m[2] !== undefined ? decodePlistString(m[2]) : (m[3] ?? '');
    out[k] = v;
  }
  return out;
}

function decodePlistString(raw: string): string {
  // Minimal XML entity decoding. Happier plists only ever emit &amp; &lt; &gt;
  // because values are paths/ids/env var names — no quotes inside strings.
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
