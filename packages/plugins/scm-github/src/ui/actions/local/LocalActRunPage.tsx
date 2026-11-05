import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  ErrorState,
  Stack,
  usePluginTranslation,
  usePluginUiEphemeralSharedScope,
} from '@happier-dev/plugin-ui';
import {
  LocalActRunSeedV1Schema,
  type LocalActRunSeedV1,
} from '../../../actions/local/contracts.js';
import { LocalActRunForm } from './LocalActRunForm.js';
import { LocalActRunFormView } from './LocalActRunFormView.js';

/**
 * The local-run form in the Session or Project details pane (`github-local-act`,
 * `github-local-act-project`). It mounts only with the host-issued mount id (L02's
 * `SurfaceContext.mountId`); without one the mounted form Actions stay unavailable and the pane
 * says so — an id is never invented here.
 */

function readSeed(
  launchInput: RenderContext['launchInput'],
): LocalActRunSeedV1 | null {
  if (
    launchInput === null ||
    typeof launchInput !== 'object' ||
    Array.isArray(launchInput) ||
    !('seed' in launchInput)
  )
    return null;
  const parsed = LocalActRunSeedV1Schema.safeParse(launchInput.seed);
  return parsed.success ? parsed.data : null;
}

export function GithubLocalActRunPage(
  props: Readonly<{ context: RenderContext }>,
): React.ReactElement {
  const t = usePluginTranslation();
  const { context } = props;
  const sharedScope = usePluginUiEphemeralSharedScope();
  const seed = React.useMemo(
    () => readSeed(context.launchInput),
    [context.launchInput],
  );
  const mountId = context.surface.mountId ?? null;
  const accountId = context.surface.accountScope?.accountId ?? null;
  if (!seed || !mountId || !accountId || !sharedScope) {
    return (
      <Stack style={{ paddingVertical: 48 }}>
        <ErrorState
          kind="unavailable"
          title={t(
            'plugins.github.localRun.unavailable.title',
            'Nothing to run here yet',
          )}
          description={
            seed
              ? t(
                  'plugins.github.localRun.unavailable.body',
                  'This pane can’t hold the local-run form right now. Open Run locally again from the failed job.',
                )
              : t(
                  'plugins.github.localRun.unavailable.noSeed',
                  'Open Run locally from a workflow, a failed job or the session’s CI panel.',
                )
          }
        />
      </Stack>
    );
  }
  return (
    <MountedForm
      context={context}
      seed={seed}
      mountId={mountId}
      accountId={accountId}
      sharedScope={sharedScope}
    />
  );
}

function MountedForm(
  props: Readonly<{
    context: RenderContext;
    seed: LocalActRunSeedV1;
    mountId: string;
    accountId: string;
    sharedScope: NonNullable<
      ReturnType<typeof usePluginUiEphemeralSharedScope>
    >;
  }>,
): React.ReactElement {
  const { context } = props;
  const host = context.hostApi;
  const phone = context.surface.platform !== 'web';
  return (
    <LocalActRunForm accountId={props.accountId} mountId={props.mountId}
      signal={context.signal} seed={props.seed} host={host} sharedScope={props.sharedScope}>
      {form => (
        <LocalActRunFormView
          form={form}
          host={host}
          machineName={form.snapshot?.machineDisplayName ?? null}
          jobLabel={form.snapshot?.selection.yamlJobId ?? props.seed.yamlJobId ?? null}
          phone={phone}
        />
      )}
    </LocalActRunForm>
  );
}
