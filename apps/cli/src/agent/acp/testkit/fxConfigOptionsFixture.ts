// Captured from FX 0.0.14 on 2026-10-27; see
// .project/tmp/vercel-meeting/E-fx-live-probe.md §3 (session/new).
export function createFxConfigOptionsFixture() {
  return [
    { id: 'provider', name: 'Provider', category: 'model', type: 'select', currentValue: 'codex', options: [
      { value: 'gateway', name: 'Vercel AI Gateway' }, { value: 'codex', name: 'Codex subscription' }, { value: 'grok', name: 'Grok subscription' },
    ] },
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-6.1-sol', options: [
      'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
    ].map((value) => ({ value, name: value })) },
    { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: 'auto', options: [
      { value: 'auto', name: 'Auto' }, { value: 'ask', name: 'Ask' }, { value: 'full-access', name: 'Full access' },
    ] },
    { id: 'effort', name: 'Reasoning Effort', category: 'thought_level', type: 'select', currentValue: 'auto', options: [
      'auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ].map((value) => ({ value, name: value === 'auto' ? 'default' : value })) },
    { id: 'fast', name: 'Fast Mode', category: 'model', type: 'select', currentValue: 'false', options: [
      { value: 'false', name: 'off' }, { value: 'true', name: 'on' },
    ] },
  ];
}
