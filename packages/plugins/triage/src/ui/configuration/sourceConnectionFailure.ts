import type { PluginTranslate } from '@happier-dev/plugin-ui';
import { TRIAGE_SOURCE_SCOPE_OUTSIDE_BINDING_CODE_V1 } from '@happier-dev/triage-protocol/v1';

import { TRIAGE_SOURCE_RETIRED_CODE } from '../../corpus/configuration/configuredSourceAuthority.js';

export function presentRetiredTriageSourceConnection(text: PluginTranslate): Readonly<{ title: string; description: string }> {
  return {
    title: text('plugins.triage.surface.detail.removedConnection.title', 'This connection is no longer configured'),
    description: text('plugins.triage.surface.detail.removedConnection.description',
      'The connection this entry was read through has been removed or replaced, so its details cannot be opened.'),
  };
}

const collectionUpdateRequired = {
  key: 'plugins.triage.sourceFailure.collectionUpdateRequired',
  fallback: 'This connection needs an update.',
};

export function presentTriageSourceConnectionFailure(
  code: string | undefined,
  text: PluginTranslate,
): Readonly<{ title: string; description?: string; recovery?: Readonly<{ label: string; url: string }> }> | undefined {
  if (code === TRIAGE_SOURCE_RETIRED_CODE) {
    return presentRetiredTriageSourceConnection(text);
  }
  if (code === TRIAGE_SOURCE_SCOPE_OUTSIDE_BINDING_CODE_V1) {
    return { title: text('plugins.triage.sourceFailure.scope-outside-binding', 'This entry’s source is no longer connected') };
  }
  if (code === 'collection_update_required') {
    return {
      title: text(collectionUpdateRequired.key, collectionUpdateRequired.fallback),
      description: text('plugins.triage.sourceFailure.collectionUpdateRecovery', 'Update Happier on the machine that reads this connection.'),
      recovery: {
        label: text('plugins.triage.sourceFailure.collectionUpdateInstructions', 'Update instructions'),
        url: 'https://docs.happier.dev/releases/updates#cli-updates-binary-vs-npm',
      },
    };
  }
  return undefined;
}
