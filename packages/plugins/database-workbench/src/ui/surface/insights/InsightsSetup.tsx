import * as React from 'react';
import type { DatabaseDescriptorV1, DatabaseStatsObservationV1, DatabaseTargetV1, DatabaseTaskEvidenceV1 } from '@happier-dev/plugin-sdk/database';
import { DATABASE_STATS_ENABLE_ACTION_ID_V1, databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { SessionInputHandoffResultV1Schema } from '@happier-dev/plugin-sdk/sessions';
import { isPluginActionConfirmationDeclined, projectPluginActionControlExecutionV1, usePluginHostApi, type PluginActionExecution } from '@happier-dev/plugin-ui/hostApi';
import {
  Action,
  Button,
  Divider,
  ErrorState,
  Icon,
  Row,
  Stack,
  SurfaceState,
  Text,
  useHappierCopyFeedback,
  usePluginTranslation,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import { databaseActionSettlement } from '../../actionSettlement.js';
import { buildDatabaseFindingBriefV1 } from '../../../insights/brief.js';
import { createDatabaseBriefHandoffControl, parseDatabaseWorktreeDraftPlacement, type DatabaseDraftPlacement } from '../../../insights/migration.js';
import type { WorkbenchLaunchInput } from '../mount.js';
import { STATEMENTS_BY_TOTAL_TIME } from './statements.js';

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
  targetKind: DatabaseTargetV1['kind'] | undefined,
): string {
  switch (reason) {
    case 'extension_missing':
    case 'unsupported_extension_version':
      return translate(
        'plugins.database.insights.setup.extension',
        'This needs PostgreSQL’s pg_stat_statements extension. Add it to this database and this list fills in.',
      );
    case 'preload_restart_required':
      if (targetKind === 'deployment_service') return composePreloadGuidance(translate);
      if (targetKind === 'managed_deployment') return translate(
        'plugins.database.insights.setup.providerPreload',
        'This needs pg_stat_statements loaded when PostgreSQL starts. Enable it in your database provider’s settings or ask its administrator.',
      );
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

function composePreloadGuidance(translate: PluginTranslate): string {
  return translate('plugins.database.insights.setup.composePreload',
    'Add pg_stat_statements to shared_preload_libraries in the PostgreSQL command in Compose, then redeploy this Environment.');
}

function EnableStatistics({ target, onRetry }: Readonly<{ target: DatabaseTargetV1; onRetry?: (() => void) | undefined }>) {
  const t = usePluginTranslation();
  const input = projectNativeJsonValueForTransport({ target, operation: 'stats.enable' });
  const [notice, setNotice] = React.useState<Readonly<{ text: string; pending?: boolean; execution?: never }>
    | Readonly<{ execution: PluginActionExecution; pending?: never }>
    | null>(null);
  return <>
    <Action.Control
      action={databaseActionLocalIdV1(DATABASE_STATS_ENABLE_ACTION_ID_V1)}
      title={t('plugins.database.insights.setup.enable', 'Enable statistics')}
      // The one action that resolves this state leads it (lab dbInsights/enable "Turn on").
      variant="primary"
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
              setNotice({ text: describeReason(t, 'preload_restart_required', target.kind) });
            }
          } else if ((!execution.ok && execution.failureCause?.errorCode === 'machine_manage_required')
            || (settled.status === 'success' && !settled.result.ok && settled.result.code === 'database_statistics_manage_required')) {
            setNotice({ text: t('plugins.database.insights.setup.manageRequired',
              'Ask a manager of this Environment’s database Machine to enable statistics.') });
          } else if (settled.status === 'success' && !settled.result.ok
            && settled.result.code === 'database_statistics_extension_privilege_required' && settled.result.reason) {
            setNotice({ text: settled.result.reason });
          } else if ('code' in settled) {
            setNotice({ execution: settled });
          } else {
            setNotice({ text: t('plugins.database.insights.setup.enableFailed', 'Statistics could not be enabled.') });
          }
        },
      }}
    />
    {notice?.execution ? <Action.Failure execution={notice.execution} />
      : notice ? <Text tone="secondary" value={notice.text} /> : null}
  </>;
}

function SetupTaskControl({ task, placement, title, accessibilityLabel, presentation }: Readonly<{
  task: DatabaseTaskEvidenceV1; placement: DatabaseDraftPlacement; title: string; accessibilityLabel?: string;
  /** Host presentation beyond the title: the agent glyph, or the handoff row's purpose line and disclosure. */
  presentation?: Readonly<{ icon?: 'generate' | 'pulse'; description?: string; disclosure?: boolean }>;
}>) {
  const t = usePluginTranslation();
  const [error, setError] = React.useState<{ title: string; details?: string } | PluginActionExecution | null>(null);
  const control = createDatabaseBriefHandoffControl(() => buildDatabaseFindingBriefV1(task), {
    handoff: { v: 1, sessionChoice: { kind: 'new' }, delivery: 'compose',
      newSession: { kind: 'new', seed: { placement } },
    },
    idempotencyKey: () => globalThis.crypto.randomUUID(),
    onSettled(execution) {
      const result = projectPluginActionControlExecutionV1(execution, t);
      if (isPluginActionConfirmationDeclined(result)) return;
      if (result.status === 'pending') return;
      if ('code' in result) {
        setError(result);
        return;
      }
      const handoff = result.status === 'success' ? SessionInputHandoffResultV1Schema.safeParse(result.result) : null;
      const delivered = handoff?.success ? handoff.data : null;
      if (delivered?.kind === 'composed' || delivered?.kind === 'authoringResult' || delivered?.kind === 'cancelled') {
        setError(null);
        return;
      }
      const details = delivered?.kind === 'failed' ? delivered.failure.errorCode
        : delivered?.kind === 'unavailable' ? delivered.reason : undefined;
      setError({ title: t('plugins.database.insights.composerUnavailable', 'The brief could not be opened in the Composer.'),
        ...(typeof details === 'string' ? { details } : {}),
      });
    },
  });
  return <><Action.Control {...control} title={title} variant="secondary" {...presentation}
      {...(accessibilityLabel === undefined ? {} : { accessibilityLabel })} />
    {error && ('status' in error ? <Action.Failure execution={error} /> : <ErrorState layout="line" {...error} />)}
  </>;
}

type WorktreeScope = Extract<WorkbenchLaunchInput['scope'], { kind: 'worktree' }>;

export function AddTelemetrySetup({ scope }: Readonly<{ scope: WorktreeScope }>) {
  const placement = parseDatabaseWorktreeDraftPlacement(scope.workspace);
  return placement ? <TelemetrySetupControl scope={scope} placement={placement} presentation="button" /> : null;
}

function TelemetrySetupControl({ scope, placement, presentation }: Readonly<{
  scope: WorktreeScope;
  placement: DatabaseDraftPlacement;
  /** Beside the statistics setup it is the handoff row (glyph, purpose, disclosure); alone (an empty rail) the one action. */
  presentation: 'button' | 'row';
}>) {
  const t = usePluginTranslation();
  const { serverId, machineId } = placement;
  return <SetupTaskControl
    task={{ kind: 'add_telemetry', sourceScope: { serverId, machineId }, scope }}
    placement={placement}
    {...(presentation === 'row' ? { presentation: { icon: 'pulse', disclosure: true,
      description: t('plugins.database.insights.setup.telemetryWhy',
        'Prepares a session that sets up OpenTelemetry, so each request’s queries show here.') } } : {})}
    title={t('plugins.database.insights.setup.addTelemetry', 'Add telemetry to this app')} />;
}

/** The setting travels by Copy; the setup state names it in its description rather than printing it (lab dbInsights). */
function CopySetting({ setting }: Readonly<{ setting: string }>) {
  const translate = usePluginTranslation();
  const hostApi = usePluginHostApi();
  const feedback = useHappierCopyFeedback();
  return <Button variant="plain" size="small" icon={<Icon name={feedback.isCopied() ? 'check' : 'copy'} size="small" />}
    title={feedback.isCopied()
      ? translate('plugins.database.insights.setup.copied', 'Copied')
      : translate('plugins.database.insights.setup.copy', 'Copy the setting')}
    onPress={() => { void feedback.copy(() => hostApi.writeClipboard(setting)); }} />;
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
  const ownServer = descriptor?.target.kind === 'deployment_service';
  const canUseOwnLogin = (descriptor?.target.kind === 'managed_deployment' || descriptor?.target.kind === 'manual')
    && descriptor.access?.canWrite === true;
  const canEnable = (ownServer || canUseOwnLogin) && props.observation.reason === 'extension_missing'
    && descriptor.capabilities.some(capability => capability.operation === 'stats.enable' && capability.available);
  const target = descriptor?.target;
  const worktree = target?.kind === 'worktree' ? target : undefined;
  const worktreePlacement = worktree ? parseDatabaseWorktreeDraftPlacement(worktree.workspace) : undefined;
  const askForStatistics = target && setup && !canEnable && props.observation.engineId === 'postgresql';
  const sourceScope = descriptor && { serverId: descriptor.placement.serverId, machineId: descriptor.placement.machineId };
  const remediation = props.observation.remediation;
  return (
    <SurfaceState
      kind={setup ? 'empty' : 'unavailable'}
      // Under the Insights tabs (or the rail's picker) the state stands where the list would start (lab dbInsights).
      placement="start"
      icon="chart"
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
      description={describeReason(translate, props.observation.reason, descriptor?.target.kind)}
      {...(remediation || canEnable || askForStatistics || props.onRetry
        ? {
            body: (
                /* One row: the way to turn it on, then the setting itself, then a recheck (lab dbInsights/notEnabled). */
                <Row gap="small" wrap justify="center">
                  {canEnable ? <EnableStatistics target={descriptor.target} onRetry={props.onRetry} /> : null}
                  {askForStatistics && sourceScope ? <SetupTaskControl
                    task={{ kind: 'enable_pg_stat_statements', engineId: 'postgresql', target, sourceScope,
                      stats: { request: STATEMENTS_BY_TOTAL_TIME, reason: props.observation.reason } }}
                    placement={{ kind: 'exactTarget', ...sourceScope,
                      ...(worktreePlacement ? { directory: worktreePlacement.directory } : {}) }}
                    presentation={{ icon: 'generate' }}
                    accessibilityLabel={translate('plugins.database.insights.setup.askAgentLabel', 'Ask an agent to enable pg_stat_statements')}
                    title={translate('plugins.database.insights.setup.askAgent', 'Ask an agent…')} /> : null}
                  {remediation ? <CopySetting setting={remediation} /> : null}
                  {props.onRetry ? <Button variant="plain" size="small" icon={<Icon name="refresh" size="small" />} onPress={props.onRetry}
                    title={translate('plugins.database.retry', 'Try again')} /> : null}
                </Row>
            ),
          }
        : {})}
      // A second way to see what each request costs, apart from the statistics setup, after its note (lab dbInsights).
      {...(worktree ? { alternative: <Stack gap="none">
        <Divider />
        {worktreePlacement ? <TelemetrySetupControl placement={worktreePlacement} presentation="row"
          scope={{ kind: 'worktree', accountId: worktree.accountId, installationId: worktree.installationId,
            projectKey: worktree.projectKey, workspace: worktree.workspace }} /> : null}
      </Stack> } : {})}
      note={translate(
        'plugins.database.insights.setup.alt',
        'Tables, indexes and live activity work without it.',
      )}
    />
  );
}
