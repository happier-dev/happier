import * as React from 'react';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import {
  Action,
  ApprovalPendingNotice,
  Button,
  Icon,
  IconButton,
  Item,
  ItemGroup,
  Row,
  ScrollArea,
  Select,
  Spinner,
  Stack,
  Text,
  TextField,
  Toggle,
  usePluginTheme,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import type { LocalRunSelection } from '../../../actions/local/contracts.js';
import { validateLocalActWorkflowSelectionV1 } from '../../../actions/local/command.js';
import type { useLocalActRunFormV1 } from './LocalActRunForm.js';
import { LocalActSecretReferenceField } from './LocalActSecretReferenceField.js';
import { LocalActMatrixField, LocalActVariablesField } from './LocalActSelectionTextFields.js';

/**
 * Run a CI job locally (lab c5). One form for every entry (a workflow's Run locally, a failed job, the
 * session rail and the fix-limit card). It edits operands only and is never a confirmation: the
 * person's Run is direct. Honest by construction: a hint, not proof; the limits are in the form itself.
 * Composition only — inspection, the project setting, Run and Stop belong to the local run controller.
 */

type FormValue = ReturnType<typeof useLocalActRunFormV1>;
type T = ReturnType<typeof usePluginTranslation>;
type PermissionKind =
  | 'loading'
  | 'off'
  | 'busy'
  | 'locked'
  | 'unavailable'
  | 'invalid'
  | 'approval'
  | 'declined'
  | 'conflict'
  | 'unknown'
  | 'allowed'
  | 'ready';

const ACT_INSTALL_URL = 'https://nektosact.com/installation/index.html';
const ARCHITECTURES = ['linux/amd64', 'linux/arm64'] as const;

function readStatus(value: unknown): string | null {
  return value !== null &&
    typeof value === 'object' &&
    'status' in value &&
    typeof value.status === 'string'
    ? value.status
    : null;
}
function isApprovalCreated(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'approval_request_created'
  );
}

/** Every cause of the first-use setting is its own state with its own next step. */
export function localActPermissionKindV1(
  snapshot: NonNullable<FormValue['snapshot']>,
): PermissionKind {
  const preference = snapshot.inspection?.preference;
  if (!preference) return 'loading';
  if (snapshot.permissionPending) return 'busy';
  if (snapshot.permissionNeedsObservation) return 'unknown';
  const permissionResult = snapshot.permissionResult?.ok ? snapshot.permissionResult.result : null;
  if (isApprovalCreated(permissionResult)) return 'approval';
  const result = readStatus(permissionResult);
  if (result === 'conflict') return 'conflict';
  if (result === 'cancelled') return 'declined';
  if (preference.status !== 'ready') return preference.status;
  if (preference.preference.allowAdHoc)
    return result === 'applied' ? 'allowed' : 'ready';
  return 'off';
}

function permissionCopy(t: T, kind: PermissionKind) {
  switch (kind) {
    case 'off':
      return {
        title: t(
          'plugins.github.localRun.perm.off.title',
          'Allow commands for this project',
        ),
        body: t(
          'plugins.github.localRun.perm.off.body',
          'Local runs use ad-hoc project commands. Allowing them also lets other explicitly requested commands run for this checkout. Each command still follows its Action approval and project setup policy. This doesn’t enable workers or give access to other projects.',
        ),
      };
    case 'busy':
      return {
        title: t(
          'plugins.github.localRun.perm.busy.title',
          'Allowing commands for this project…',
        ),
        body: t(
          'plugins.github.localRun.perm.busy.body',
          'One change to the project setting is being saved. Nothing has started.',
        ),
      };
    case 'loading':
      return {
        title: t(
          'plugins.github.localRun.perm.loading.title',
          'Checking the project setting',
        ),
        body: t(
          'plugins.github.localRun.perm.loading.body',
          'Reading whether commands are allowed here. Your choices are kept.',
        ),
      };
    case 'locked':
      return {
        title: t(
          'plugins.github.localRun.perm.locked.title',
          'The project setting is locked',
        ),
        body: t(
          'plugins.github.localRun.perm.locked.body',
          'It needs an unlock before it can be read, so Happier can’t tell whether commands are allowed. This isn’t “off”, and nothing was changed. Your choices are kept.',
        ),
      };
    case 'unavailable':
      return {
        title: t(
          'plugins.github.localRun.perm.unavailable.title',
          'Can’t read the project setting',
        ),
        body: t(
          'plugins.github.localRun.perm.unavailable.body',
          'It didn’t answer just now, so Happier can’t tell whether commands are allowed. This isn’t “off”, and nothing was changed. Your choices are kept.',
        ),
      };
    case 'invalid':
      return {
        title: t(
          'plugins.github.localRun.perm.invalid.title',
          'The saved setting isn’t valid',
        ),
        body: t(
          'plugins.github.localRun.perm.invalid.body',
          'Its stored value can’t be understood, so Happier doesn’t treat it as off and doesn’t write a default over it. Your choices are kept. Review it in the project’s settings.',
        ),
      };
    case 'approval':
      return {
        title: t(
          'plugins.github.localRun.perm.approval.title',
          'Waiting for approval',
        ),
        body: t(
          'plugins.github.localRun.perm.approval.body',
          'Allowing commands is waiting on its own approval. Nothing runs, and nothing else changes, until it is answered.',
        ),
      };
    case 'declined':
      return {
        title: t(
          'plugins.github.localRun.perm.declined.title',
          'Approval declined',
        ),
        body: t(
          'plugins.github.localRun.perm.declined.body',
          'Commands stay off for this project and nothing started. You can allow them again whenever you like.',
        ),
      };
    case 'conflict':
      return {
        title: t(
          'plugins.github.localRun.perm.conflict.title',
          'The setting changed elsewhere',
        ),
        body: t(
          'plugins.github.localRun.perm.conflict.body',
          'The setting has a newer version than the one you saw. Review the current value, then allow again if you still want to.',
        ),
      };
    case 'unknown':
      return {
        title: t(
          'plugins.github.localRun.perm.unknown.title',
          'Couldn’t confirm the change',
        ),
        body: t(
          'plugins.github.localRun.perm.unknown.body',
          'No reply came back, so Happier doesn’t know whether commands are now allowed. It checks the setting before it writes again, and never starts a run.',
        ),
      };
    case 'allowed':
      return {
        title: t(
          'plugins.github.localRun.perm.allowed.title',
          'Commands allowed for this project',
        ),
        body: t(
          'plugins.github.localRun.perm.allowed.body',
          'Nothing has started. Your choices are still here; Run is a separate step.',
        ),
      };
    case 'ready':
      return null;
  }
}

function runRefusalCopy(t: T, code: string): string {
  switch (code) {
    case 'event_not_found':
      return t(
        'plugins.github.localRun.refused.event',
        'Choose an event this workflow listens for.',
      );
    case 'job_not_found':
      return t(
        'plugins.github.localRun.refused.job',
        'Choose a job from this workflow.',
      );
    case 'dynamic_runner_unsupported':
      return t(
        'plugins.github.localRun.refused.dynamic',
        'This job picks its runner at run time, which a local run can’t reproduce.',
      );
    case 'native_runner_unsupported':
      return t(
        'plugins.github.localRun.refused.native',
        'This job runs on macOS or Windows; local runs use Linux containers.',
      );
    case 'image_mapping_required':
      return t(
        'plugins.github.localRun.refused.image',
        'Choose an image for each runner label.',
      );
    default:
      return t(
        'plugins.github.localRun.refused.generic',
        'Some choices need attention before this can run.',
      );
  }
}

export function LocalActRunFormView(
  props: Readonly<{
    form: FormValue;
    host: Pick<PluginUiHostApi, 'openExternalLink'>;
    machineName: string | null;
    jobLabel: string | null;
    phone?: boolean;
    /** Omitted inside a host pane, whose own header closes it. */
    onClose?: () => void;
  }>,
): React.ReactElement {
  const t = usePluginTranslation();
  const theme = usePluginTheme();
  const { controller, snapshot, pendingApproval } = props.form;
  const [advanced, setAdvanced] = React.useState(false);
  const machine =
    props.machineName ??
    t('plugins.github.localRun.machineFallback', 'this checkout’s Machine');
  if (!controller || !snapshot) {
    return (
      <Stack
        gap="none"
        style={{
          minHeight: 240,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Spinner />
      </Stack>
    );
  }
  const { selection, inspection } = snapshot;
  const set = (patch: Partial<LocalRunSelection>) => {
    const next = { ...selection, ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) Reflect.deleteProperty(next, key);
    }
    controller.setSelection(next);
  };
  const workflow = inspection?.workflow ?? null;
  const labels = props.form.runnerRequirements?.kind === 'ready' ? props.form.runnerRequirements.labels : [];
  const permission = localActPermissionKindV1(snapshot);
  const permissionNotice = permissionCopy(t, permission);
  const toolMissing = inspection?.tool.kind === 'unavailable';
  const validation = workflow
    ? validateLocalActWorkflowSelectionV1(selection, workflow)
    : null;
  const canRun = controller.canRun();
  const accepted = snapshot.runState === 'accepted';
  const running = props.form.operationStatus === 'running';
  const uncertain = snapshot.runState === 'uncertain';
  const title = t('plugins.github.localRun.title', 'Run {job} locally', {
    job:
      props.jobLabel ??
      selection.yamlJobId ??
      t('plugins.github.localRun.thisJob', 'this job'),
  });

  const why = toolMissing
    ? t(
        'plugins.github.localRun.why.act',
        'Run is available once act is found.',
      )
    : permission === 'locked'
      ? t(
          'plugins.github.localRun.why.locked',
          'Run is available once the project setting is unlocked.',
        )
      : permission === 'unavailable'
        ? t(
            'plugins.github.localRun.why.unavailable',
            'Run is available once the project setting can be read.',
          )
        : permission === 'invalid'
          ? t(
              'plugins.github.localRun.why.invalid',
              'Run is available once the project setting is valid.',
            )
          : permission === 'loading'
            ? t(
                'plugins.github.localRun.why.loading',
                'Run is available once the project setting is read.',
              )
            : permission === 'unknown'
              ? t(
                  'plugins.github.localRun.why.unknown',
                  'Run is available once the setting is confirmed.',
                )
              : ['off', 'approval', 'declined', 'conflict', 'busy'].includes(
                    permission,
                  )
                ? t(
                    'plugins.github.localRun.why.off',
                    'Run is available once commands are allowed for this project.',
                  )
                : inspection?.workflowError
                  ? t(
                      'plugins.github.localRun.why.workflow',
                      'Run is available once the workflow can be read.',
                    )
                  : !selection.architecture.trim()
                    ? t(
                        'plugins.github.localRun.why.arch',
                        'Choose an architecture to run.',
                      )
                    : validation?.kind === 'refused'
                      ? runRefusalCopy(t, validation.code)
                      : t(
                          'plugins.github.localRun.hint',
                          'Runs act in this project’s terminal on {machine}',
                          { machine },
                        );

  const prerequisite = (() => {
    if (toolMissing)
      return (
        <Item
          icon={<Icon name="warning" size="small" tone="attention" />}
          title={t('plugins.github.localRun.act.missing', 'act wasn’t found')}
          subtitle={t(
            'plugins.github.localRun.act.missingBody',
            'act runs workflow jobs in containers. Install it on {machine} by the official instructions, then retry. Happier doesn’t install it for you.',
            { machine },
          )}
          accessoryWraps
          accessoryOutsidePressable
          accessory={
            <Row gap="small">
              <Button
                size="small"
                variant="secondary"
                icon={<Icon name="external" size="small" />}
                title={t(
                  'plugins.github.localRun.act.guide',
                  'Installation guide',
                )}
                onPress={() => {
                  void props.host
                    .openExternalLink(ACT_INSTALL_URL)
                    .catch(() => {});
                }}
              />
              <Button
                size="small"
                variant="plain"
                title={t('plugins.github.localRun.retry', 'Retry')}
                busy={snapshot.loading}
                onPress={() => {
                  void controller.inspect();
                }}
              />
            </Row>
          }
        />
      );
    if (inspection?.workflowError)
      return (
        <Item
          icon={<Icon name="warning" size="small" tone="attention" />}
          title={t(
            'plugins.github.localRun.workflow.error',
            'The workflow can’t be read',
          )}
          subtitle={inspection.workflowError}
          accessoryOutsidePressable
          accessory={
            <Button
              size="small"
              variant="plain"
              title={t('plugins.github.localRun.retry', 'Retry')}
              busy={snapshot.loading}
              onPress={() => {
                void controller.inspect();
              }}
            />
          }
        />
      );
    if (permissionNotice) {
      const action =
        permission === 'off' || permission === 'declined' || permission === 'busy' ? (
          <Action.Control
            action="projects.worker.preferences.set"
            controller={controller.allowControl}
            signal={props.form.signal}
            disabled={permission === 'busy'}
            title={permission === 'busy'
              ? t('plugins.github.localRun.perm.allowing', 'Allowing…')
              : t('plugins.github.localRun.perm.allow', 'Allow for this project')}
          />
        ) : permission === 'unknown' ||
          permission === 'conflict' ||
          permission === 'unavailable' ? (
          <Button
            size="small"
            variant="secondary"
            title={
              permission === 'conflict'
                ? t('plugins.github.localRun.perm.review', 'Review')
                : permission === 'unknown'
                  ? t('plugins.github.localRun.perm.checkAgain', 'Check again')
                  : t('plugins.github.localRun.retry', 'Retry')
            }
            onPress={() => {
              void (permission === 'unavailable'
                ? controller.inspect()
                : controller.observePermission());
            }}
          />
        ) : null;
      return (
        <Item
          icon={
            permission === 'loading' || permission === 'busy' ? (
              <Spinner size="small" />
            ) : (
              <Icon
                name={permission === 'allowed' ? 'check' : 'denied'}
                size="small"
                tone={permission === 'allowed' ? 'success' : 'attention'}
              />
            )
          }
          title={permissionNotice.title}
          subtitle={permissionNotice.body}
          accessoryBelow={action !== null}
          accessoryOutsidePressable
          {...(action === null ? {} : { accessory: action })}
        />
      );
    }
    return (
      <Item
        icon={<Icon name="check" size="small" tone="success" />}
        title={t('plugins.github.localRun.ready', 'Ready on {machine}', {
          machine,
        })}
        subtitle={t(
          'plugins.github.localRun.readyBody',
          'act found · commands allowed for this project',
        )}
      />
    );
  })();

  const jobOptions = (workflow?.jobs ?? []).map((row) => ({
    value: row.id,
    label: row.id,
  }));
  const eventOptions = (workflow?.events ?? []).map((event) => ({
    value: event,
    label: event,
  }));
  const field = {
    fieldAccessory: true,
    accessoryOutsidePressable: true,
  } as const;

  const form = (
    <ItemGroup surface="sheet" testID="github-local-run-operands">
      <Item
        title={t('plugins.github.localRun.job', 'Job')}
        subtitle={selection.workflowPath || undefined}
        {...field}
        accessory={
          jobOptions.length > 0 ? (
            <Select
              presentation="field"
              label={t('plugins.github.localRun.job', 'Job')}
              value={selection.yamlJobId ?? ''}
              options={jobOptions}
              onChange={(value) => set({ yamlJobId: String(value) })}
            />
          ) : (
            <Text
              tone="muted"
              value={
                snapshot.loading
                  ? t(
                      'plugins.github.localRun.reading',
                      'Reading the workflow…',
                    )
                  : t('plugins.github.localRun.noJobs', 'No jobs found')
              }
            />
          )
        }
      />
      <Item
        title={t('plugins.github.localRun.runOn', 'Run on')}
        subtitle={t(
          'plugins.github.localRun.runOn.body',
          'This checkout’s primary Machine and its current checkout; it may differ from the failed commit',
        )}
        detail={machine}
        icon={<Icon name="desktop" size="small" tone="secondary" />}
      />
      <Item
        title={t('plugins.github.localRun.event', 'Event')}
        {...field}
        accessory={
          eventOptions.length > 0 ? (
            <Select
              presentation="field"
              label={t('plugins.github.localRun.event', 'Event')}
              value={selection.event}
              options={eventOptions}
              onChange={(value) => set({ event: String(value) })}
            />
          ) : (
            <Text tone="muted" value={selection.event || '—'} />
          )
        }
      />
      {(labels.length > 0 ? labels : ['']).filter(Boolean).map((label) => (
        <Item
          key={label}
          title={t('plugins.github.localRun.image', 'Image for {label}', {
            label,
          })}
          subtitle={t(
            'plugins.github.localRun.image.body',
            'The reviewed runner label → a real image reference',
          )}
          {...field}
          accessory={
            <TextField
              presentation="field"
              label={t(
                'plugins.github.localRun.image.field',
                'Image for {label}',
                { label },
              )}
              value={
                selection.platforms.find((row) => row.label === label)?.image ??
                ''
              }
              placeholder="ghcr.io/catthehacker/ubuntu:act-22.04"
              autoCapitalize="none"
              autoCorrect={false}
              onChange={(image) =>
                set({
                  platforms: [
                    ...selection.platforms.filter((row) => row.label !== label),
                    ...(image.trim() ? [{ label, image }] : []),
                  ],
                })
              }
            />
          }
        />
      ))}
      <Item
        title={t('plugins.github.localRun.arch', 'Architecture')}
        {...field}
        accessory={
          <Select
            presentation="segmented"
            label={t('plugins.github.localRun.arch', 'Architecture')}
            value={selection.architecture}
            options={ARCHITECTURES.map((value) => ({ value, label: value }))}
            onChange={(value) => set({ architecture: String(value) })}
          />
        }
      />
      <Item
        title={t('plugins.github.localRun.advanced', 'Advanced')}
        subtitle={t(
          'plugins.github.localRun.advanced.body',
          'Event file, matrix, variables, artifacts',
        )}
        onPress={() => setAdvanced((open) => !open)}
        accessibilityExpanded={advanced}
        expanded={advanced}
        expandedContent={
          <Stack gap="medium" style={{ paddingTop: theme.spacing.small }}>
            <TextField
              label={t('plugins.github.localRun.eventFile', 'Event file')}
              value={selection.eventPath ?? ''}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder=".github/events/pull_request.json"
              onChange={(value) =>
                set({ eventPath: value.trim() ? value : undefined })
              }
            />
            <Text
              variant="meta"
              tone="muted"
              value={t(
                'plugins.github.localRun.eventFile.hint',
                'A local file; the hosted event payload isn’t available.',
              )}
            />
            <LocalActMatrixField
              label={t('plugins.github.localRun.matrix', 'Matrix')}
              value={selection.matrix}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="os:ubuntu-latest"
              onChange={(matrix) => set({ matrix })}
            />
            <Text
              variant="meta"
              tone="muted"
              value={t(
                'plugins.github.localRun.matrix.hint',
                'Free entries, passed to act as typed; nothing is evaluated.',
              )}
            />
            <LocalActVariablesField
              label={t('plugins.github.localRun.variables', 'Variables')}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              value={selection.variables}
              placeholder="CI_SHARD=1"
              onChange={(variables) => set({ variables })}
            />
            <Text
              variant="meta"
              tone="muted"
              value={t(
                'plugins.github.localRun.variables.hint',
                'Non-secret NAME=value lines. They aren’t masked.',
              )}
            />
            <Toggle
              label={t('plugins.github.localRun.artifacts', 'Artifacts')}
              value={selection.artifactServerPath !== undefined}
              onChange={(value) =>
                set({
                  artifactServerPath: value
                    ? '.happier/act-artifacts'
                    : undefined,
                })
              }
            />
            <Text
              variant="meta"
              tone="muted"
              value={t(
                'plugins.github.localRun.artifacts.hint',
                'On: a local folder and an act listener. Off by default.',
              )}
            />
            <Text
              variant="meta"
              tone="secondary"
              value={t(
                'plugins.github.localRun.inherited',
                'Your act config still applies: .actrc files are read; the default .secrets, .env, .vars and .input files aren’t.',
              )}
            />
          </Stack>
        }
      />
      <Item
        title={t('plugins.github.localRun.secrets', 'Secrets')}
        subtitle={
          inspection && inspection.secretRequirements.length > 0
            ? t(
                'plugins.github.localRun.secrets.declared',
                'Declared in .happier/project.json: {names}',
                {
                  names: inspection.secretRequirements
                    .map((row) => row.name)
                    .join(', '),
                },
              )
            : t(
                'plugins.github.localRun.secrets.none',
                'None declared. Pick a secret file on {machine}, or run without secrets.',
                { machine },
              )
        }
        {...field}
        accessory={
          <TextField
            presentation="field"
            label={t(
              'plugins.github.localRun.secretFile',
              'Secret file on {machine}',
              { machine },
            )}
            value={selection.secretFilePath ?? ''}
            placeholder={t(
              'plugins.github.localRun.secretFile.placeholder',
              'No secret file',
            )}
            autoCapitalize="none"
            autoCorrect={false}
            onChange={(value) =>
              set({ secretFilePath: value.trim() ? value : undefined })
            }
          />
        }
      />
      {(inspection?.secretRequirements ?? []).filter(requirement => requirement.kind === 'secret').map(requirement => (
        <LocalActSecretReferenceField
          key={JSON.stringify([selection.workspace, requirement.name])}
          name={requirement.name}
          binding={selection.environmentBindings?.bindings[requirement.name]}
          onChange={binding => {
            const current = controller.getSnapshot().selection;
            const bindings = { ...current.environmentBindings?.bindings };
            if (binding) bindings[requirement.name] = binding;
            else delete bindings[requirement.name];
            const { environmentBindings: _previous, ...rest } = current;
            controller.setSelection(Object.keys(bindings).length ? { ...rest, environmentBindings: { v: 1, bindings } } : rest);
          }}
        />
      ))}
      {inspection?.secretRequirements.some(requirement => requirement.name === 'GITHUB_TOKEN') ? null : <Item
        title="GITHUB_TOKEN"
        detail={t('plugins.github.localRun.token.empty', 'Empty')}
        subtitle={t(
          'plugins.github.localRun.token.body',
          'Or a declared reference; never read from gh or a secret file',
        )}
      />}
    </ItemGroup>
  );

  const secretsGuide = advanced ? (
    <ItemGroup
      title={t(
        'plugins.github.localRun.secretsGuide.title',
        'Where Secrets come from',
      )}
      surface="sheet"
    >
      <Item
        title={t(
          'plugins.github.localRun.secretsGuide.refs',
          'Saved Secret references',
        )}
        subtitle={t(
          'plugins.github.localRun.secretsGuide.refsBody',
          'They need declarations you maintain in this checkout’s .happier/project.json. Happier never creates or edits that file.',
        )}
      />
      <Item
        title={t(
          'plugins.github.localRun.secretsGuide.scope',
          'A required declaration applies to every ad-hoc command',
        )}
        subtitle={t(
          'plugins.github.localRun.secretsGuide.scopeBody',
          'Not only this job. A declaration marked not required, used only by this workflow, avoids that.',
        )}
      />
      <Item
        title={t(
          'plugins.github.localRun.secretsGuide.file',
          'Or pick a secret file',
        )}
        subtitle={t(
          'plugins.github.localRun.secretsGuide.fileBody',
          'A file that already exists on {machine} needs no declarations. A run with no secrets needs neither.',
          { machine },
        )}
      />
    </ItemGroup>
  ) : null;

  const limits = (
    <Stack
      gap="small"
      style={{
        padding: theme.spacing.medium,
        borderRadius: theme.radii.panel,
        backgroundColor: theme.colors.elevatedSurface,
      }}
    >
      <Row gap="small" align="center">
        <Icon name="info" size="small" tone="secondary" />
        <Text
          variant="label"
          value={t(
            'plugins.github.localRun.limits.title',
            'What a local run can and can’t tell you',
          )}
        />
      </Row>
      <Text
        variant="meta"
        tone="secondary"
        value={t(
          'plugins.github.localRun.limits.hint',
          'A hint, not proof. It runs in a Linux container on this Machine, not on GitHub’s hosted runner. Images can be large.',
        )}
      />
      <Text
        variant="meta"
        tone="secondary"
        value={t(
          'plugins.github.localRun.limits.hosted',
          'Hosted credentials, OIDC, environments and caches may be unavailable, and steps can behave differently.',
        )}
      />
      <Text
        variant="meta"
        tone="secondary"
        value={t(
          'plugins.github.localRun.limits.pass',
          'A local pass doesn’t clear CI. It changes nothing on GitHub.',
        )}
      />
    </Stack>
  );

  const outcome = accepted ? (
    <Item
      icon={running ? <Spinner size="small" /> : undefined}
      title={running ? t('plugins.github.localRun.running', 'Running on {machine}', {
        machine,
      }) : props.form.operationStatus ?? snapshot.operationObservation}
      subtitle={t(
        'plugins.github.localRun.running.body',
        'act’s own output is in this project’s terminal. Stop ends the process; act normally removes its containers, but an abrupt stop can leave some behind and Happier doesn’t check.',
      )}
      accessoryBelow
      accessoryOutsidePressable
      accessory={
        <Row gap="small">
          <Button
            size="small"
            variant="secondary"
            icon={<Icon name="terminal" size="small" />}
            title={t('plugins.github.localRun.openOutput', 'Open in terminal')}
            onPress={() => {
              void controller.openOutput();
            }}
          />
          <Button
            size="small"
            variant="plain"
            icon={<Icon name="stop" size="small" />}
            title={t('plugins.github.localRun.stop', 'Stop')}
            onPress={() => {
              void controller.stop();
            }}
          />
        </Row>
      }
    />
  ) : uncertain ? (
    <Item
      icon={<Icon name="warning" size="small" tone="attention" />}
      title={t(
        'plugins.github.localRun.uncertain',
        'Couldn’t confirm the run started',
      )}
      subtitle={t(
        'plugins.github.localRun.uncertain.body',
        'The request may have reached {machine}. Happier won’t send it again on its own; check the project terminal before running again.',
        { machine },
      )}
    />
  ) : null;

  return (
    <ScrollArea>
      <Stack
        gap="large"
        style={{
          padding: props.phone ? theme.spacing.medium : theme.spacing.large,
          maxWidth: 760,
          width: '100%',
          alignSelf: 'center',
        }}
        testID="github-local-run-form"
      >
        <Row gap="small" align="flex-start">
          <Stack grow gap="xsmall">
            <Text variant="heading" value={title} />
            <Text
              tone="secondary"
              value={t(
                'plugins.github.localRun.description',
                'Run this job with act in a Linux container on your Machine, in your current checkout.',
              )}
            />
          </Stack>
          {props.onClose ? (
            <IconButton
              accessibilityLabel={t('plugins.github.localRun.close', 'Close')}
              icon={<Icon name="close" size="small" />}
              onPress={props.onClose}
            />
          ) : null}
        </Row>
        {pendingApproval ? <ApprovalPendingNotice subject={title} onOpen={() => { void props.host.openExternalLink(pendingApproval.href).catch(() => {}); }} /> : null}
        <ItemGroup surface="sheet">{prerequisite}</ItemGroup>
        {outcome ? <ItemGroup surface="sheet">{outcome}</ItemGroup> : null}
        {form}
        {secretsGuide}
        {limits}
        <Row gap="small" align="center" wrap>
          <Text variant="meta" tone="muted" value={why} />
          <Stack grow gap="none" />
          {props.onClose ? (
            <Button
              variant="plain"
              title={t('plugins.github.localRun.cancel', 'Cancel')}
              onPress={props.onClose}
            />
          ) : null}
          <Action.Control
            action="projects.compute.exec"
            controller={controller.runControl}
            signal={props.form.signal}
            disabled={!canRun}
            title={
              accepted
                ? t('plugins.github.localRun.runAgain', 'Run again')
                : t('plugins.github.localRun.run', 'Run on {machine}', {
                    machine,
                  })
            }
          />
        </Row>
      </Stack>
    </ScrollArea>
  );
}
