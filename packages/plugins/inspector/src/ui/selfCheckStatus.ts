import type { PluginTranslate, TextTone } from '@happier-dev/plugin-ui';

export type InspectorSelfCheckSettlement = 'not-run' | 'success' | 'failed';

/** The self-check's status line: its words and the one tone they are drawn in. */
export function readInspectorSelfCheckStatus(
  settlement: InspectorSelfCheckSettlement,
  text: PluginTranslate,
): Readonly<{ label: string; tone: TextTone }> {
  if (settlement === 'not-run') {
    return { label: text('plugins.inspector.surface.selfCheckNotRun', 'Self-check not run yet'), tone: 'secondary' };
  }
  return settlement === 'success'
    ? { label: text('plugins.inspector.surface.selfCheckPassed', 'Self-check passed'), tone: 'secondary' }
    : { label: text('plugins.inspector.surface.selfCheckFailed', 'Self-check failed'), tone: 'danger' };
}
