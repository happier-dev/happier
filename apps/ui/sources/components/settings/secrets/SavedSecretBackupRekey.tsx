import * as React from 'react';
import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { SavedSecretBackupRekeyRequiredV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import type { DeploymentEnvironmentHeaderV1 } from '@happier-dev/deployments/contracts/v1';

import { createDeploymentActions } from '@/components/projects/deployments/deploymentActions';
import { deploymentWorkStatus } from '@/components/projects/deployments/deploymentPresentation';
import { createDeploymentReadTransport } from '@/components/projects/deployments/deploymentReadTransport';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createSavedSecretResource } from '@/sync/ops/settings/savedSecretResourceOperations';
import { t } from '@/text';

/** What the blocked Replace needs to finish: the value the person entered and the Replace to try again. */
export type SavedSecretBackupRekeyInput = Readonly<{
  lifetime: ServerAccountScopeLifetime;
  secretName: string;
  value: string;
  details: SavedSecretBackupRekeyRequiredV1;
  /** The original Replace, unchanged; true when it went through. */
  retryReplace: () => Promise<boolean>;
}>;

/**
 * Replace refused with `backup_rekey_required` (owner-approved flow, OWNER-RULINGS:292): the entered value becomes a
 * separate Saved Secret, each named backup moves to it through `deployments.backups.configure` rekeyAndSave, then the
 * original Replace runs again. Resolves true when the secret was replaced. The Action owners decide every step.
 */
export function reviewSavedSecretBackupRekey(
  input: SavedSecretBackupRekeyInput,
): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.show({
      component: SavedSecretBackupRekeySheet,
      props: { input, onSettled: resolve },
      closeOnBackdrop: false,
    });
  });
}

type Step = 'waiting' | 'running' | 'done' | 'failed';
type Backup = Readonly<{
  environmentId: string;
  role: SavedSecretBackupRekeyRequiredV1['backups'][number]['role'];
}>;
type Phase = 'review' | 'running' | 'partial' | 'replaceFailed' | 'finished';

const ID = 'secrets.backup-rekey';
const STEP_STATE = {
  waiting: 'queued',
  running: 'running',
  done: 'succeeded',
  failed: 'failed',
} as const;

function SavedSecretBackupRekeySheet(
  props: Readonly<{
    input: SavedSecretBackupRekeyInput;
    onSettled: (replaced: boolean) => void;
  }> &
    CustomModalInjectedProps,
) {
  const { input } = props;
  const backups: readonly Backup[] = input.details.backups;
  const [phase, setPhase] = React.useState<Phase>('review');
  const [steps, setSteps] = React.useState<Readonly<Record<string, Step>>>({});
  const [environments, setEnvironments] = React.useState<
    Readonly<Record<string, DeploymentEnvironmentHeaderV1 & { name: string }>>
  >({});
  // One separate secret per review: a retry after a partial failure moves the rest to the same one.
  const replacement = React.useRef<Readonly<{
    ref: string;
    resourceRevision: number;
  }> | null>(null);
  const settled = React.useRef(false);
  const settle = React.useCallback(
    (replaced: boolean) => {
      if (settled.current) return;
      settled.current = true;
      props.onSettled(replaced);
      props.onClose();
    },
    [props.onClose, props.onSettled],
  );
  React.useEffect(
    () => () => {
      if (!settled.current) {
        settled.current = true;
        props.onSettled(false);
      }
    },
    [],
  );

  // Each backup is named by its Environment; the same read gives the revision the re-key is admitted against.
  React.useEffect(() => {
    const controller = new AbortController();
    const transport = createDeploymentReadTransport(input.lifetime);
    const scope = {
      serverId: input.lifetime.scope.serverId,
      accountId: input.lifetime.scope.accountId,
    };
    void Promise.all(
      backups.map(async (backup) => {
        const read = await transport.readEnvironment(
          scope,
          backup.environmentId,
          { signal: controller.signal },
        );
        return read.ok
          ? ([
              backup.environmentId,
              { ...read.value.environment, name: read.value.content.name },
            ] as const)
          : null;
      }),
    ).then((rows) => {
      if (controller.signal.aborted) return;
      setEnvironments(Object.fromEntries(rows.filter((row) => row !== null)));
    });
    return () => controller.abort();
  }, [backups, input.lifetime]);

  const blocked = input.details.hasOtherBackups || backups.length === 0;
  const run = React.useCallback(async () => {
    setPhase('running');
    setSteps((current) => Object.fromEntries(backups.map((backup) => [backup.environmentId,
      current[backup.environmentId] === 'done' ? 'done' as const : 'waiting' as const])));
    if (!replacement.current) {
      const created = await createSavedSecretResource({
        scope: input.lifetime.scope,
        name: t('secrets.catalog.rekeySecretName', { name: input.secretName }),
        kind: 'apiKey',
        value: input.value,
        accountGrants: [],
        teamGrants: [],
        groupGrants: [],
      });
      if (!created.ok) {
        setSteps(
          Object.fromEntries(
            backups.map((backup) => [backup.environmentId, 'failed' as const]),
          ),
        );
        setPhase('partial');
        return;
      }
      replacement.current = {
        ref: created.resourceRef,
        resourceRevision: created.revision,
      };
    }
    const selection = replacement.current;
    const actions = createDeploymentActions(input.lifetime);
    let failed = false;
    for (const backup of backups) {
      if (steps[backup.environmentId] === 'done') continue;
      const environment = environments[backup.environmentId];
      setSteps((current) => ({
        ...current,
        [backup.environmentId]: 'running',
      }));
      let ok = false;
      if (environment) {
        try {
          const result = await actions.configureBackup(environment, {
            intent: 'rekeyAndSave',
            replacement: selection,
          });
          ok = result.kind === 'configured';
        } catch {
          // The Action owner's refusal leaves this backup on the old secret; the row says it failed and Try again retries it.
        }
      }
      failed ||= !ok;
      setSteps((current) => ({
        ...current,
        [backup.environmentId]: ok ? 'done' : 'failed',
      }));
    }
    if (failed) {
      setPhase('partial');
      return;
    }
    setPhase((await input.retryReplace()) ? 'finished' : 'replaceFailed');
  }, [backups, environments, input, steps]);

  const busy = phase === 'running';
  const primary =
    phase === 'finished' ? null : (
      <RoundButton
        size="normal"
        testID={`${ID}.${phase === 'review' ? 'start' : 'retry'}`}
        loading={busy}
        disabled={busy || blocked}
        title={
          phase === 'review' || phase === 'running'
            ? t('secrets.catalog.rekeyAction')
            : t('secrets.catalog.rekeyRetry')
        }
        onPress={() => {
          void (phase === 'replaceFailed'
            ? input
                .retryReplace()
                .then((ok) => setPhase(ok ? 'finished' : 'replaceFailed'))
            : run());
        }}
      />
    );
  const footer = (
    <ModalCardFooterActions
      cancel={{
        onPress: () => settle(phase === 'finished'),
        testID: `${ID}.cancel`,
        disabled: busy,
        ...(phase === 'finished' ? { title: t('common.close') } : {}),
      }}
    >
      {primary}
    </ModalCardFooterActions>
  );
  useModalCardChrome(props.setChrome, {
    kind: 'card',
    title: t('secrets.catalog.rekeyTitle'),
    subtitle: input.secretName,
    testID: ID,
    phonePresentation: 'sheet',
    scrollHost: 'body',
    footer,
    dimensions: {
      width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide,
      maxHeightRatio: 0.9,
      size: 'md',
    },
  });

  const note =
    phase === 'partial'
      ? t('secrets.catalog.rekeyPartial')
      : phase === 'replaceFailed'
        ? t('secrets.catalog.rekeyReplaceFailed')
        : phase === 'finished'
          ? t('secrets.catalog.rekeyFinished')
          : input.details.hasOtherBackups
            ? t('secrets.catalog.rekeyOtherBackups')
            : null;
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <ListPresentationProvider value="page" pageInsets="contained">
        <ItemGroup
          testID={`${ID}.backups`}
          description={t('secrets.catalog.rekeyBody')}
        >
          {backups.map((backup) => {
            const step = steps[backup.environmentId];
            const role =
              backup.role === 'repositoryPassword'
                ? t('secrets.catalog.rekeyRoleRepository')
                : t('secrets.catalog.rekeyRoleUnknown');
            const where = step ? t(STEP_COPY[step]) : null;
            return (
              <Item
                key={backup.environmentId}
                testID={`${ID}.backup.${backup.environmentId}`}
                mode="info"
                title={
                  environments[backup.environmentId]?.name ??
                  t('secrets.catalog.rekeyUnnamed')
                }
                subtitle={where ? `${role} · ${where}` : role}
                {...(step
                  ? {
                      leftElement: (
                        <WorkStatusGlyph
                          status={deploymentWorkStatus(STEP_STATE[step])}
                          testIDSuffix={`rekey-${backup.environmentId}`}
                        />
                      ),
                    }
                  : {})}
              />
            );
          })}
        </ItemGroup>
        {note ? (
          <SurfaceStateCard
            testID={`${ID}.${phase}`}
            size="line"
            kind={
              // Done is quiet success; a partial move needs the person (amber); a failed Replace failed (rose).
              phase === 'finished'
                ? 'success'
                : phase === 'replaceFailed'
                  ? 'error'
                  : 'warning'
            }
            title={note}
          />
        ) : null}
      </ListPresentationProvider>
    </ScrollView>
  );
}

const STEP_COPY = {
  waiting: 'secrets.catalog.rekeyWaiting',
  running: 'secrets.catalog.rekeyRunning',
  done: 'secrets.catalog.rekeyDone',
  failed: 'secrets.catalog.rekeyFailed',
} as const;

const styles = StyleSheet.create((theme) => ({
  body: { paddingHorizontal: theme.space.s20, paddingBottom: theme.space.s24 },
}));

