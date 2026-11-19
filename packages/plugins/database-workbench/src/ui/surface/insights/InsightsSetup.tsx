import * as React from 'react';
import type { DatabaseStatsObservationV1 } from '@happier-dev/plugin-sdk/database';
import {
  CodeBlock,
  Stack,
  SurfaceState,
  usePluginTranslation,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';

type Unavailable = Extract<
  DatabaseStatsObservationV1,
  { status: 'unavailable' }
>;

/** Reasons that mean statement statistics are not turned on yet; every other reason is a plain unavailable line. */
const SETUP_REASONS: ReadonlySet<Unavailable['reason']> = new Set([
  'extension_missing',
  'preload_restart_required',
  'instrumentation_disabled',
  'unsupported_extension_version',
]);

export function isStatsSetupReason(reason: Unavailable['reason']): boolean {
  return SETUP_REASONS.has(reason);
}

function describeReason(
  translate: PluginTranslate,
  reason: Unavailable['reason'],
): string {
  switch (reason) {
    case 'extension_missing':
    case 'unsupported_extension_version':
      return translate(
        'plugins.database.insights.setup.extension',
        'This needs PostgreSQL’s pg_stat_statements extension. Add it to this database and this list fills in.',
      );
    case 'preload_restart_required':
      return translate(
        'plugins.database.insights.setup.preload',
        'This needs pg_stat_statements loaded when postgres starts. Add the setting below and restart postgres, and this list fills in.',
      );
    case 'instrumentation_disabled':
      return translate(
        'plugins.database.insights.setup.instrumentation',
        'Statement statistics are turned off on this server. Turn them on in its settings and this list fills in.',
      );
    case 'visibility_restricted':
      return translate(
        'plugins.database.insights.unavailable.visibility',
        'This connection isn’t allowed to read statement statistics. A role with pg_read_all_stats can.',
      );
    case 'unsupported_engine':
    case 'unsupported_transport':
    case 'unsupported_group':
      return translate(
        'plugins.database.insights.unavailable.engine',
        'This database doesn’t keep statement statistics.',
      );
    default:
      return translate(
        'plugins.database.insights.unavailable.other',
        'Statement statistics aren’t available right now.',
      );
  }
}

/**
 * P4's one diagnosed setup state, the same on the page and in the rail (D24 C). The producer's remediation is the
 * setting to copy. Turn on (database.stats.enable) and Ask an agent (R7 handoff) join here once their producers are
 * registered; until then nothing is drawn that cannot succeed.
 */
export function InsightsSetup(
  props: Readonly<{
    observation: Unavailable;
    size?: 'pane' | 'details' | 'page' | 'phone';
  }>,
) {
  const translate = usePluginTranslation();
  const setup = isStatsSetupReason(props.observation.reason);
  return (
    <SurfaceState
      kind={setup ? 'empty' : 'unavailable'}
      {...(props.size ? { size: props.size } : {})}
      title={
        setup
          ? translate(
              'plugins.database.insights.setup.title',
              'See which statements cost the most',
            )
          : translate(
              'plugins.database.insights.unavailable.title',
              'No statement statistics',
            )
      }
      description={describeReason(translate, props.observation.reason)}
      {...(props.observation.remediation
        ? {
            body: (
              <Stack gap="small">
                <CodeBlock
                  code={props.observation.remediation}
                  copyLabel={translate(
                    'plugins.database.insights.setup.copy',
                    'Copy the setting',
                  )}
                  copiedLabel={translate(
                    'plugins.database.insights.setup.copied',
                    'Copied',
                  )}
                />
              </Stack>
            ),
          }
        : {})}
      note={translate(
        'plugins.database.insights.setup.alt',
        'Tables, indexes and live activity work without it.',
      )}
    />
  );
}
