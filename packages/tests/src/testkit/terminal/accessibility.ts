export type TerminalAccessibilityRenderer =
  | 'xterm-web'
  | 'xterm-webview'
  | 'ios-ghosttykit'
  | 'android-termux';

export type TerminalAccessibilityPlatform = 'web' | 'ios' | 'android';

export type TerminalAccessibilityNode = Readonly<{
  role: string;
  label?: string;
}>;

export type TerminalAccessibilityObservation = Readonly<{
  renderer: TerminalAccessibilityRenderer;
  platform: TerminalAccessibilityPlatform;
  nodes: readonly TerminalAccessibilityNode[];
  actions: readonly string[];
}>;

export type TerminalAccessibilityGate =
  | Readonly<{
      state: 'accepted';
      renderer: TerminalAccessibilityRenderer;
      platform: TerminalAccessibilityPlatform;
    }>
  | Readonly<{
      state: 'fallback-required';
      reason: 'opaque-tree' | 'no-terminal-content';
      renderer: TerminalAccessibilityRenderer;
      platform: TerminalAccessibilityPlatform;
    }>;

const USEFUL_ACTIONS = new Set(['copy', 'select', 'open-link', 'accessibility-summary']);

export function classifyTerminalAccessibilityGate(
  observation: TerminalAccessibilityObservation,
): TerminalAccessibilityGate {
  const hasUsefulText = observation.nodes.some((node) => (node.label ?? '').trim().length > 0);
  const hasUsefulAction = observation.actions.some((action) => USEFUL_ACTIONS.has(action));
  if (hasUsefulText || hasUsefulAction) {
    return {
      state: 'accepted',
      renderer: observation.renderer,
      platform: observation.platform,
    };
  }

  const isOpaqueTree = observation.nodes.length <= 1
    && observation.nodes.every((node) => node.role === 'other' || node.role === 'view');
  return {
    state: 'fallback-required',
    reason: isOpaqueTree ? 'opaque-tree' : 'no-terminal-content',
    renderer: observation.renderer,
    platform: observation.platform,
  };
}
