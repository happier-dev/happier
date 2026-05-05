import fs from 'node:fs';

/**
 * Semantic equivalence check for darwin launchd plist service definitions.
 *
 * Background: the previous raw-file-equality check (`installed.trim() ===
 * expected.trim()`) reported spurious drift because the expected content is
 * regenerated on every invocation using the caller's `process.env.PATH`,
 * which includes ephemeral segments like `fnm_multishells/<pid>_<ts>/bin`
 * and cwd-derived `node_modules/.bin`.
 *
 * This comparator extracts only the fields that materially determine runtime
 * behavior and compares those. It intentionally ignores `PATH`, but keeps
 * launcher / entrypoint identity inside `ProgramArguments` because that is the
 * executable contract for the installed service definition.
 *
 * Returns true when both definitions would launch the same daemon under the
 * same Happier home, launcher target, channel, and target mode — i.e. no
 * meaningful drift.
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

  const installed = extractPlistSignature(installedRaw);
  const expected = extractPlistSignature(params.expectedContents);
  if (!installed || !expected) return false;
  return compareServiceSignatures(installed, expected);
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
 * ProgramArguments are part of the installed service contract. Keep launcher
 * identity, entrypoint path, and trailing daemon args aligned so drifted
 * launchers (for example an old `node <old>/index.mjs` path) are detected.
 */
function compareProgramArgumentsSemantically(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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
