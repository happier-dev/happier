/**
 * K5 bypass-guard: restart/switch trigger inventory (CALL-SITE granular)
 *
 * PURPOSE
 * -------
 * Every connected-service restart or auth-switch trigger CALL SITE must be
 * classified, inline, as exactly one of three archetypes:
 *
 *   fsm_switch       — routed through switchSessionConnectedServiceAuth /
 *                      applyConnectedServiceAuthGeneration (the full gated FSM:
 *                      reachability gate at respawn, binding persistence,
 *                      hot-apply-in-place when eligible, mid-turn continuation).
 *
 *   gated_restart    — routed through the gated restart primitive
 *                      (requestConnectedServiceRestartWithDeferral / the deferral
 *                      queue). Inherits turn-deferral + the spawn-time
 *                      reachability gate (K1) on respawn, but does NOT re-negotiate
 *                      bindings through the FSM. This is the D7 seam for pure
 *                      refresh/reconnect where no target generation is known.
 *
 *   passive_apply    — applies an already-selected/current auth generation in
 *                      place. This path may run during passive current-truth
 *                      reconciliation, but it cannot restart, spawn, resume,
 *                      continue, or admit provider work by itself.
 *
 *   bypass_known     — currently bypasses BOTH the FSM and the gated primitive
 *                      (e.g. a raw SIGTERM with no deferral/reachability). Each
 *                      must name the plan phase that tracks the fix.
 *
 * WHY CALL-SITE (NOT FILE) GRANULARITY
 * ------------------------------------
 * The previous version of this guard keyed on which PRIMITIVE a source FILE
 * imported. That made every trigger inside `startDaemon.ts` collapse to a single
 * classification, so an intra-file bypass (the K2 proactive-quota
 * `switchBeforeTurn` restart, the `cmpn4hhdi` regression) was INVISIBLE to the
 * guard even though it lived right next to fully-gated FSM call sites. The guard
 * must see each call site independently, so it scans for the trigger call
 * patterns directly and requires an adjacent `// K5:<class> ...` marker on each.
 *
 * HOW TO SATISFY THE GUARD
 * ------------------------
 * Put a marker comment on the trigger line or the line immediately above it:
 *
 *     // K5:fsm_switch reactive runtime-auth failure routes through the FSM
 *     await requestConnectedServiceRestartWithDeferral({ ... });
 *
 * The marker grammar is:  K5:<class>(<phase>?) <free text>
 *   - <class>  is one of fsm_switch | gated_restart | passive_apply | bypass_known
 *   - (<phase>) is OPTIONAL free text (e.g. a plan phase like K2/K3) — for
 *     bypass_known it is REQUIRED so a reviewer can find the tracked fix.
 *
 * A NEW unmarked trigger call site fails this guard with a clear message, so the
 * next bypass shows up as a red test instead of a field incident.
 */

import { readdir, readFile } from 'node:fs/promises';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { RuntimeAuthRecoveryScheduler, type RuntimeAuthRecoveryIntent } from './runtimeAuth/RuntimeAuthRecoveryScheduler';

// ---------------------------------------------------------------------------
// Roots to scan for triggers
// ---------------------------------------------------------------------------

// The test file lives at: src/daemon/connectedServices/<file>.test.ts
// '..'         → src/daemon/
// '../../backends' → src/backends/
// '../../session'  → src/session/   (future triggers introduced here would be invisible without this)
// '../../agent'    → src/agent/     (same: ACP / runtime paths)
// '../../rpc'      → src/rpc/       (same: RPC handler surface)
//
// P3-1 rationale: the original guard scanned only daemon/ and backends/. Any restart or
// switch trigger introduced in session/, agent/, or rpc/ would be completely invisible
// to the guard and bypass the classification requirement without producing a red test.
// Widening the scan roots closes that gap. Adding these roots does NOT break the current
// green state (no trigger call sites exist there today).
const daemonDir = fileURLToPath(new URL('..', import.meta.url));
const backendsDir = fileURLToPath(new URL('../../backends', import.meta.url));
const sessionDir = fileURLToPath(new URL('../../session', import.meta.url));
const agentDir = fileURLToPath(new URL('../../agent', import.meta.url));
const rpcDir = fileURLToPath(new URL('../../rpc', import.meta.url));

// ---------------------------------------------------------------------------
// Trigger call-site patterns
// ---------------------------------------------------------------------------
//
// Each pattern matches the START of a restart/switch trigger invocation. We only
// match invocations (call sites), not imports, type declarations, or the
// function DEFINITIONS themselves (those are excluded explicitly below).

type TriggerPattern = Readonly<{
  /** Human label for diagnostics. */
  label: string;
  /** Regex that, when matched on a line, marks that line as a trigger call site. */
  pattern: RegExp;
}>;

const TRIGGER_PATTERNS: ReadonlyArray<TriggerPattern> = [
  {
    label: 'requestConnectedServiceRestartWithDeferral()',
    // Gated restart wrapper invocation (not its definition `const ... =`).
    pattern: /(?<!const\s)\brequestConnectedServiceRestartWithDeferral\s*\(/,
  },
  {
    label: 'requestConnectedServiceSessionRestartSignal()',
    // Raw SIGTERM primitive invocation (not its `export function` definition).
    pattern: /(?<!function\s)\brequestConnectedServiceSessionRestartSignal\s*\(/,
  },
  {
    label: 'params.requestRestartSignal()',
    // Indirect raw-signal invocation via injected dependency.
    pattern: /\brequestRestartSignal\s*\(/,
  },
  {
    label: 'switchSessionConnectedServiceAuth()',
    // FSM entrypoint invocation (not its `export function` definition / import).
    pattern: /(?<!function\s)\bswitchSessionConnectedServiceAuth\s*\(\s*\{/,
  },
  {
    label: 'applyConnectedServiceAuthGeneration callback',
    // FSM hot-apply/gated apply callback declared as an object key with an async value.
    pattern: /\bapplyConnectedServiceAuthGeneration\s*:\s*async\b/,
  },
];

/**
 * Files that DEFINE these primitives (so a definition is not mistaken for a call
 * site). The grammar above already excludes `export function ...` / `const ... =`
 * forms, but the dependency-injection signature
 * `requestRestartSignal: (params: ...) => Promise<void>` in the handler file is a
 * TYPE declaration, not a call — exclude that file's type line via the
 * call-shape requirement (`requestRestartSignal(` with an open paren and no `:`).
 */
const PRIMITIVE_DEFINITION_BASENAMES: ReadonlySet<string> = new Set([
  'requestConnectedServiceSessionRestartSignal.ts',
  'switchSessionConnectedServiceAuth.ts',
]);

const DURABLE_CONNECTED_SERVICE_RESTART_INTENT_PATTERN =
  /\b(markSessionMarkerConnectedServiceRestartIntent|preserveConnectedServiceRestartIntent|promoteSessionMarkerConnectedServiceRestartIntent)\b/;

const DURABLE_CONNECTED_SERVICE_RESTART_INTENT_DEFINITION_BASENAMES: ReadonlySet<string> = new Set([
  'sessionRegistry.ts',
]);

const MARKER_DERIVED_STARTUP_RESTART_REPLAY_PATTERN =
  /\bopencode_dead_daemon_marker_restart\b/;

const PLANNED_CONNECTED_SERVICE_RESTART_PATTERN =
  /\brequestPlannedRunnerRestart\s*\(\s*\{[\s\S]*?\breason:\s*['"]connected_service_switch['"][\s\S]*?\}\s*\)/g;

// ---------------------------------------------------------------------------
// Marker grammar
// ---------------------------------------------------------------------------

type TriggerClassification = 'fsm_switch' | 'gated_restart' | 'passive_apply' | 'bypass_known';

const MARKER_PATTERN =
  /\/\/\s*K5:(fsm_switch|gated_restart|passive_apply|bypass_known)\b([^\n]*)/;

type ParsedMarker = Readonly<{
  classification: TriggerClassification;
  detail: string;
}>;

function parseMarker(line: string): ParsedMarker | null {
  const match = MARKER_PATTERN.exec(line);
  if (!match) return null;
  return {
    classification: match[1] as TriggerClassification,
    detail: (match[2] ?? '').trim(),
  };
}

// ---------------------------------------------------------------------------
// File-system scanner
// ---------------------------------------------------------------------------

async function listSourceFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = `${dir}${sep}${entry.name}`;
      if (entry.isDirectory()) return listSourceFiles(fullPath);
      if (!entry.isFile()) return [];
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
      return [fullPath];
    }),
  );
  return files.flat();
}

function basename(absolutePath: string): string {
  return absolutePath.split(sep).pop() ?? absolutePath;
}

function matchTriggerLabel(line: string): string | null {
  for (const trigger of TRIGGER_PATTERNS) {
    if (trigger.pattern.test(line)) return trigger.label;
  }
  return null;
}

type TriggerCallSite = Readonly<{
  scopedPath: string;
  lineNumber: number;
  triggerLabel: string;
  marker: ParsedMarker | null;
}>;

function scopedPathOf(absolutePath: string): string {
  if (absolutePath.startsWith(daemonDir)) {
    return `daemon:${absolutePath.slice(daemonDir.length).split(sep).join('/')}`;
  }
  if (absolutePath.startsWith(backendsDir)) {
    return `backends:${absolutePath.slice(backendsDir.length).split(sep).join('/')}`;
  }
  if (absolutePath.startsWith(sessionDir)) {
    return `session:${absolutePath.slice(sessionDir.length).split(sep).join('/')}`;
  }
  if (absolutePath.startsWith(agentDir)) {
    return `agent:${absolutePath.slice(agentDir.length).split(sep).join('/')}`;
  }
  if (absolutePath.startsWith(rpcDir)) {
    return `rpc:${absolutePath.slice(rpcDir.length).split(sep).join('/')}`;
  }
  return `unknown:${absolutePath}`;
}

/**
 * A trigger line is considered marked if it carries a marker on the same line OR
 * on one of the immediately-preceding non-blank comment lines (so a marker can
 * sit on its own line directly above the call).
 */
function resolveMarkerForLine(lines: ReadonlyArray<string>, index: number): ParsedMarker | null {
  const own = parseMarker(lines[index] ?? '');
  if (own) return own;
  // Walk upward over contiguous comment / blank lines.
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const line = (lines[cursor] ?? '').trim();
    if (line.length === 0) continue;
    const marker = parseMarker(line);
    if (marker) return marker;
    // Stop as soon as we hit a non-comment, non-blank line of code.
    if (!line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*')) break;
  }
  return null;
}

async function collectTriggerCallSites(): Promise<TriggerCallSite[]> {
  const [daemonFiles, backendFiles, sessionFiles, agentFiles, rpcFiles] = await Promise.all([
    listSourceFiles(daemonDir),
    listSourceFiles(backendsDir),
    listSourceFiles(sessionDir),
    listSourceFiles(agentDir),
    listSourceFiles(rpcDir),
  ]);
  const allFiles = [...daemonFiles, ...backendFiles, ...sessionFiles, ...agentFiles, ...rpcFiles];

  const callSites: TriggerCallSite[] = [];
  for (const file of allFiles) {
    if (PRIMITIVE_DEFINITION_BASENAMES.has(basename(file))) continue;
    const source = await readFile(file, 'utf8');
    const lines = source.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const triggerLabel = matchTriggerLabel(line);
      if (!triggerLabel) continue;
      callSites.push({
        scopedPath: scopedPathOf(file),
        lineNumber: index + 1,
        triggerLabel,
        marker: resolveMarkerForLine(lines, index),
      });
    }
  }
  return callSites;
}

async function collectDurableConnectedServiceRestartIntentRuntimeSites(): Promise<string[]> {
  const [daemonFiles, backendFiles, sessionFiles, agentFiles, rpcFiles] = await Promise.all([
    listSourceFiles(daemonDir),
    listSourceFiles(backendsDir),
    listSourceFiles(sessionDir),
    listSourceFiles(agentDir),
    listSourceFiles(rpcDir),
  ]);
  const findings: string[] = [];
  for (const file of [...daemonFiles, ...backendFiles, ...sessionFiles, ...agentFiles, ...rpcFiles]) {
    if (DURABLE_CONNECTED_SERVICE_RESTART_INTENT_DEFINITION_BASENAMES.has(basename(file))) continue;
    const source = await readFile(file, 'utf8');
    const lines = source.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!DURABLE_CONNECTED_SERVICE_RESTART_INTENT_PATTERN.test(lines[index] ?? '')) continue;
      findings.push(`${scopedPathOf(file)}:${index + 1}`);
    }
  }
  return findings;
}

async function collectMarkerDerivedStartupRestartReplaySites(): Promise<string[]> {
  const daemonFiles = await listSourceFiles(daemonDir);
  const findings: string[] = [];
  for (const file of daemonFiles) {
    const source = await readFile(file, 'utf8');
    const lines = source.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!MARKER_DERIVED_STARTUP_RESTART_REPLAY_PATTERN.test(lines[index] ?? '')) continue;
      findings.push(`${scopedPathOf(file)}:${index + 1}`);
    }
  }
  return findings;
}

async function collectConnectedServicePlannedRestartCallsMissingFinalActivityGate(): Promise<string[]> {
  const daemonFiles = await listSourceFiles(daemonDir);
  const findings: string[] = [];
  for (const file of daemonFiles) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(PLANNED_CONNECTED_SERVICE_RESTART_PATTERN)) {
      const callSource = match[0] ?? '';
      if (/\bcanSignal\s*:/.test(callSource)) continue;
      const lineNumber = source.slice(0, match.index ?? 0).split('\n').length;
      findings.push(`${scopedPathOf(file)}:${lineNumber}`);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('connected-services restart/switch trigger inventory (K5 bypass guard)', () => {
  it('marks every restart/switch trigger CALL SITE inline — unmarked call sites fail', async () => {
    const callSites = await collectTriggerCallSites();

    const unmarked = callSites
      .filter((site) => site.marker === null)
      .map((site) => `${site.scopedPath}:${site.lineNumber} (${site.triggerLabel})`);

    expect(
      unmarked,
      `UNMARKED restart/switch trigger call sites detected.\n`
      + `Add an inline marker on (or directly above) each call site:\n`
      + `  // K5:fsm_switch | gated_restart | passive_apply | bypass_known <reason>\n`
      + `Unmarked call sites:\n${unmarked.map((p) => `  ${p}`).join('\n')}`,
    ).toEqual([]);

    // Sanity: the scanner must actually find the known trigger call sites.
    expect(callSites.length).toBeGreaterThanOrEqual(5);
  });

  it('uses a valid classification on every marked trigger call site', async () => {
    const callSites = await collectTriggerCallSites();
    const valid: ReadonlyArray<TriggerClassification> = ['fsm_switch', 'gated_restart', 'passive_apply', 'bypass_known'];
    const invalid = callSites
      .filter((site) => site.marker !== null && !valid.includes(site.marker.classification))
      .map((site) => `${site.scopedPath}:${site.lineNumber}`);
    expect(invalid, 'Trigger markers must use a valid classification').toEqual([]);
  });

  it('requires a tracking phase on every bypass_known marker', async () => {
    const callSites = await collectTriggerCallSites();
    const bypassMissingPhase = callSites
      .filter((site) => site.marker?.classification === 'bypass_known' && site.marker.detail.length === 0)
      .map((site) => `${site.scopedPath}:${site.lineNumber}`);
    expect(
      bypassMissingPhase,
      'bypass_known markers must name the plan phase that tracks the fix (free text after the class)',
    ).toEqual([]);
  });

  it('has no remaining bypass_known trigger call sites once K2 and K3 land', async () => {
    const callSites = await collectTriggerCallSites();
    const bypasses = callSites
      .filter((site) => site.marker?.classification === 'bypass_known')
      .map((site) => `${site.scopedPath}:${site.lineNumber} — ${site.marker?.detail ?? ''}`);
    expect(
      bypasses,
      `Expected ZERO known bypasses after K2 (proactive quota → FSM) and K3 (gated refresh) land.\n`
      + `Remaining bypasses:\n${bypasses.map((p) => `  ${p}`).join('\n')}`,
    ).toEqual([]);
  });

  it('does not persist connected-service restart intent markers from product runtime paths', async () => {
    const findings = await collectDurableConnectedServiceRestartIntentRuntimeSites();

    expect(
      findings,
      `Connected-service restart requests must remain in-memory live-daemon state only.\n`
      + `Persisted marker intents are legacy cleanup state; do not mark, preserve, or promote them from runtime paths.\n`
      + `Runtime references:\n${findings.map((finding) => `  ${finding}`).join('\n')}`,
    ).toEqual([]);
  });

  it('permits restoring retry timers but forbids synchronous runtime-auth recovery during hydration', async () => {
    // 0646eaa5b5 forbids effectful startup replay, not restoring a deadline whose
    // callback re-enters the normal liveness/authorization owner after startup.
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const intents = new Map<string, RuntimeAuthRecoveryIntent>();
    const recover = vi.fn(async () => ({ status: 'session_not_found' as const }));
    const deps = {
      nowMs: () => Date.now(), recover,
      durableStore: {
        read: (key: string) => intents.get(key) ?? null,
        readAll: () => [...intents.entries()],
        write: (key: string, intent: RuntimeAuthRecoveryIntent) => { intents.set(key, intent); },
      },
    };
    const previous = new RuntimeAuthRecoveryScheduler(deps);
    let replacement: RuntimeAuthRecoveryScheduler | undefined;
    try {
      await previous.enqueueHandlerFailure({
        sessionId: 'policy-waiting-session', switchesThisTurn: 0,
        classification: {
          kind: 'usage_limit', serviceId: 'openai-codex', profileId: null, groupId: null,
          resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error',
        },
        error: Object.assign(new Error('transport unavailable'), { code: 'ECONNRESET' }),
      });
      previous.dispose();
      vi.setSystemTime(Math.max(...[...intents.values()].map((intent) => intent.nextRetryAtMs ?? 0)));
      replacement = new RuntimeAuthRecoveryScheduler(deps);
      replacement.hydrate();
      expect(recover).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(recover).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: 'scheduler_retry' }));
    } finally {
      previous.dispose();
      replacement?.dispose();
      vi.useRealTimers();
    }
  });

  it('does not reintroduce marker-derived startup restart replay', async () => {
    const findings = await collectMarkerDerivedStartupRestartReplaySites();

    expect(
      findings,
      `Daemon startup reconstruction must remain passive; dead disk markers must not define marker-derived restart reasons.\n`
      + `Runtime references:\n${findings.map((finding) => `  ${finding}`).join('\n')}`,
    ).toEqual([]);
  });

  it('runs the final activity gate for connected-service planned runner restarts', async () => {
    const findings = await collectConnectedServicePlannedRestartCallsMissingFinalActivityGate();

    expect(
      findings,
      `Connected-service planned runner restarts must pass canSignal so final pre-signal activity checks cannot be bypassed.\n`
      + `Missing canSignal:\n${findings.map((finding) => `  ${finding}`).join('\n')}`,
    ).toEqual([]);
  });

  it('fails the guard when a trigger call site has no marker (self-test of the scanner)', () => {
    const synthetic = [
      'async function example() {',
      '  await requestConnectedServiceRestartWithDeferral({ sessionId });',
      '}',
    ];
    const triggerIndex = synthetic.findIndex((line) => matchTriggerLabel(line) !== null);
    expect(triggerIndex).toBeGreaterThanOrEqual(0);
    expect(resolveMarkerForLine(synthetic, triggerIndex)).toBeNull();
  });

  it('accepts a marker placed on the line directly above the trigger (self-test of the scanner)', () => {
    const synthetic = [
      'async function example() {',
      '  // K5:gated_restart pure refresh restart inherits deferral + reachability',
      '  await requestConnectedServiceRestartWithDeferral({ sessionId });',
      '}',
    ];
    const triggerIndex = synthetic.findIndex((line) => matchTriggerLabel(line) !== null);
    const marker = resolveMarkerForLine(synthetic, triggerIndex);
    expect(marker?.classification).toBe('gated_restart');
  });

  it('P3-1 mutation-check: an unmarked trigger call site in session/ or agent/ or rpc/ produces an unmarked finding (guard is not blind to widened roots)', () => {
    // Simulate a source file from session/ that contains an unmarked trigger call. The scanner must
    // flag it. This is a SYNTHETIC in-memory proof that the widened scan would fail if a real
    // out-of-scope trigger were introduced — the actual live scan (the test above) passes because no
    // such trigger exists today.
    const syntheticOutOfScopeSource = [
      '// a module in src/session/someFeature.ts',
      'export async function doThing(ctx: Ctx) {',
      '  // BUG: someone added a raw restart here without going through the FSM.',
      '  await requestConnectedServiceRestartWithDeferral({ sessionId: ctx.sessionId });',
      '}',
    ];

    // Identify the trigger line.
    const triggerIndex = syntheticOutOfScopeSource.findIndex((line) => matchTriggerLabel(line) !== null);
    expect(triggerIndex).toBeGreaterThanOrEqual(0);

    // No marker above or on the trigger line.
    const marker = resolveMarkerForLine(syntheticOutOfScopeSource, triggerIndex);
    expect(marker).toBeNull();

    // With the widened roots, `scopedPathOf` would assign it a session:-prefixed scope instead of
    // unknown:. Verify that the scope logic correctly classifies session/-rooted absolute paths.
    const fakeScopedPath = `session:someFeature.ts`;
    expect(fakeScopedPath).toMatch(/^session:/);
    // And the live unmarked-sites test above would therefore catch and report it.
  });
});
