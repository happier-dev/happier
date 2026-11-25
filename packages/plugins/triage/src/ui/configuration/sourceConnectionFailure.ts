import type { PluginTranslate } from '@happier-dev/plugin-ui';

import { TRIAGE_SOURCE_RETIRED_CODE } from '../../corpus/configuration/configuredSourceAuthority.js';

// The source owns this code. Triage uses it only to present connection recovery.
export const SCOPE_OUTSIDE_BINDING_CODE = 'scope-outside-binding';

export function presentRetiredTriageSourceConnection(text: PluginTranslate): Readonly<{ title: string; description: string }> {
  return {
    title: text('plugins.triage.surface.detail.removedConnection.title', 'This connection is no longer configured'),
    description: text('plugins.triage.surface.detail.removedConnection.description',
      'The connection this entry was read through has been removed or replaced, so its details cannot be opened.'),
  };
}

export function presentTriageSourceConnectionFailure(
  code: string | undefined,
  text: PluginTranslate,
  hasRetiredConnection = false,
): Readonly<{ title: string; description?: string }> | undefined {
  if (code === TRIAGE_SOURCE_RETIRED_CODE || (code === SCOPE_OUTSIDE_BINDING_CODE && hasRetiredConnection)) {
    return presentRetiredTriageSourceConnection(text);
  }
  if (code === SCOPE_OUTSIDE_BINDING_CODE) {
    return { title: text('plugins.triage.sourceFailure.scope-outside-binding', 'This entry’s source is no longer connected') };
  }
  return undefined;
}
