import type { PluginUiIconTokenV1 } from '@happier-dev/plugin-sdk/ui';
import type { PluginUiResourceIntentV1 } from '@happier-dev/plugin-sdk/protocol';

/**
 * The declared icon of the `entries` Composer control.
 *
 * `change-open` is the mark the plugin's own surfaces and rail use for PRs &
 * Issues, so the composer control reads as the same place. It lives here
 * rather than beside the compact renderer because the manifest declares it:
 * importing it from a `.tsx` module would drag React into the daemon manifest
 * graph and close an import cycle through `TRIAGE_DISPLAY_NAME`.
 */
export const TRIAGE_ENTRIES_CONTROL_ICON_V1: PluginUiIconTokenV1 = 'change-open';

export const TRIAGE_RESOURCE_DETAILS_LOCAL_ID_V1 = 'resource-details';

/** Provider URL offers; immutable entry identity remains the source's exact lookup. */
export function triageResourceLinks(destination: string) {
  const repository = 'https://github\\.com/[^/?#]+/[^/?#]+';
  const tail = '/[1-9][0-9]*(?:/[^?#]*)?(?:\\?[^#]*)?(?:#.*)?$';
  return [
    { kind: 'pullRequest' as const, urlPattern: `^${repository}/pull${tail}`, destination },
    { kind: 'issue' as const, urlPattern: `^${repository}/issues${tail}`, destination },
    { kind: 'securityAlert' as const, urlPattern: `^${repository}/security/(?:dependabot|code-scanning)${tail}`, destination },
  ];
}

/** The declared offers also recover an existing destination's URL discriminator. */
export function readTriageResourceIntent(url: string): PluginUiResourceIntentV1 | undefined {
  const offered = triageResourceLinks('').find(link => new RegExp(link.urlPattern).test(url));
  return offered === undefined ? undefined : { kind: offered.kind, url };
}
