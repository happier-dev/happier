export const TERMINAL_FOUNDATION_LIFECYCLE_SCENARIO_IDS = [
  'daemon-restart-live-surface',
  'app-restart-byte-replay',
  'concurrent-terminals-independent-cursors',
  'feature-denied-or-missing-server-bit',
  'native-webview-fallback-module-missing',
  'renderer-crash-or-webview-boot-failure',
  'memory-retention-cleanup',
  'old-new-client-compatibility',
  'windows-conpty-legacy-fallback',
] as const;

export type TerminalFoundationLifecycleScenarioId =
  typeof TERMINAL_FOUNDATION_LIFECYCLE_SCENARIO_IDS[number];

export type TerminalFoundationLifecycleScenario = Readonly<{
  id: TerminalFoundationLifecycleScenarioId;
  description: string;
  requiredEvidence: readonly string[];
}>;

const SCENARIOS: readonly TerminalFoundationLifecycleScenario[] = Object.freeze([
  {
    id: 'daemon-restart-live-surface',
    description: 'Daemon restart keeps a live terminal surface recoverable through byte replay or explicit gap.',
    requiredEvidence: ['restart', 'read', 'gap-or-replay'],
  },
  {
    id: 'app-restart-byte-replay',
    description: 'App restart reconnects and hydrates from daemon byte ring instead of cached string-only output.',
    requiredEvidence: ['app-restart', 'byte-offset-read', 'surface-hydration'],
  },
  {
    id: 'concurrent-terminals-independent-cursors',
    description: 'Multiple terminals maintain independent byte offsets, ACK state, and gap handling.',
    requiredEvidence: ['two-session-ids', 'independent-cursors', 'independent-acks'],
  },
  {
    id: 'feature-denied-or-missing-server-bit',
    description: 'Missing or denied feature bits fail closed without silently falling back to byte stream.',
    requiredEvidence: ['feature-disabled', 'explicit-fallback-state'],
  },
  {
    id: 'native-webview-fallback-module-missing',
    description: 'Native builds without terminal-native artifacts keep xterm WebView available.',
    requiredEvidence: ['module-unavailable', 'webview-selected'],
  },
  {
    id: 'renderer-crash-or-webview-boot-failure',
    description: 'Renderer crash or WebView boot failure does not lose session ownership.',
    requiredEvidence: ['failure-detected', 'fallback-or-retry'],
  },
  {
    id: 'memory-retention-cleanup',
    description: 'Terminal close, idle cleanup, daemon shutdown, and restart release bounded buffers.',
    requiredEvidence: ['close', 'idle-cleanup', 'bounded-memory'],
  },
  {
    id: 'old-new-client-compatibility',
    description: 'Old/new client and daemon combinations use explicit version negotiation.',
    requiredEvidence: ['old-client', 'new-client', 'negotiated-version'],
  },
  {
    id: 'windows-conpty-legacy-fallback',
    description: 'Windows/ConPTY remains legacy-only unless raw byte fidelity is proven.',
    requiredEvidence: ['platform-win32', 'byte-proof-or-legacy-diagnostic'],
  },
]);

export function listTerminalFoundationLifecycleScenarios(): readonly TerminalFoundationLifecycleScenario[] {
  return SCENARIOS;
}

export function assertTerminalValidationMatrixCovers(
  observedScenarioIds: readonly TerminalFoundationLifecycleScenarioId[],
): void {
  const observed = new Set(observedScenarioIds);
  const missing = TERMINAL_FOUNDATION_LIFECYCLE_SCENARIO_IDS.filter((scenarioId) => !observed.has(scenarioId));
  if (missing.length > 0) {
    throw new Error(`missing terminal validation scenarios: ${missing.join(', ')}`);
  }
}
