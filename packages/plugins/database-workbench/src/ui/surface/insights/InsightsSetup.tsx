import * as React from 'react';
import type { DatabaseDescriptorV1, DatabaseStatsObservationV1, DatabaseTargetV1 } from '@happier-dev/plugin-sdk/database';
import { DATABASE_STATS_ENABLE_ACTION_ID_V1, databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { isPluginActionConfirmationDeclined } from '@happier-dev/plugin-ui/hostApi';
import {
  Action,
  Button,
  CodeBlock,
  Row,
  Stack,
  SurfaceState,
  Text,
  usePluginTranslation,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import { databaseActionSettlement } from '../../actionSettlement.js';

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

function EnableStatistics({ target, onRetry }: Readonly<{ target: DatabaseTargetV1; onRetry?: (() => void) | undefined }>) {
  const t = usePluginTranslation();
  const input = projectNativeJsonValueForTransport({ target, operation: 'stats.enable' });
  const [notice, setNotice] = React.useState<Readonly<{ text: string; pending?: boolean }> | null>(null);
  return <>
    <Action.Control
      action={databaseActionLocalIdV1(DATABASE_STATS_ENABLE_ACTION_ID_V1)}
      title={t('plugins.database.insights.setup.enable', 'Enable statistics')}
      disabled={notice?.pending === true}
      controller={{
        prepare: async () => ({ input }),
        onSettled(execution) {
          const settled = databaseActionSettlement(execution, 'stats.enable');
          if (isPluginActionConfirmationDeclined(settled)) return;
          if (settled.status === 'pending') {
            setNotice({ text: t('plugins.database.insights.setup.pending', 'Waiting for approval.'), pending: true });
          } else if (settled.status === 'success' && settled.result.ok && settled.result.operation === 'stats.enable') {
            if (settled.result.status === 'enabled') {
              setNotice(null);
              onRetry?.();
            } else {
              setNotice({ text: t('plugins.database.insights.setup.restartRequired',
                'Add pg_stat_statements to shared_preload_libraries and restart PostgreSQL before retrying.') });
            }
          } else {
            setNotice({ text: 'message' in settled ? settled.message
              : t('plugins.database.insights.setup.enableFailed', 'Statistics could not be enabled.') });
          }
        },
      }}
    />
    {notice ? <Text tone="secondary" value={notice.text} /> : null}
  </>;
}

/** One diagnosed setup state for the page and rail (D24 C). */
export function InsightsSetup(
  props: Readonly<{
    observation: Unavailable;
    size?: 'pane' | 'details' | 'page' | 'phone';
    descriptor?: DatabaseDescriptorV1;
    onRetry?: () => void;
  }>,
) {
  const translate = usePluginTranslation();
  const setup = isStatsSetupReason(props.observation.reason);
  const descriptor = props.descriptor;
  const canEnable = (descriptor?.target.kind === 'deployment_service' || descriptor?.target.kind === 'managed_deployment')
    && props.observation.reason === 'extension_missing'
    && descriptor.access?.canWrite === true
    && descriptor.capabilities.some(capability => capability.operation === 'stats.enable' && capability.available);
  const remediation = props.observation.remediation;
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
      {...(remediation || canEnable || props.onRetry
        ? {
            body: (
              <Stack gap="small">
                {remediation ? <CodeBlock
                  code={remediation}
                  copyLabel={translate(
                    'plugins.database.insights.setup.copy',
                    'Copy the setting',
                  )}
                  copiedLabel={translate(
                    'plugins.database.insights.setup.copied',
                    'Copied',
                  )}
                /> : null}
                {canEnable || props.onRetry ? <Row gap="small" wrap>
                  {canEnable ? <EnableStatistics target={descriptor.target} onRetry={props.onRetry} /> : null}
                  {props.onRetry ? <Button variant="plain" size="small" onPress={props.onRetry}
                    title={translate('plugins.database.retry', 'Try again')} /> : null}
                </Row> : null}
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
