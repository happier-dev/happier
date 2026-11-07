import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  resolveEffectiveActionInputFields,
  type EffectiveActionInputField,
} from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';

import {
  ActionInputFields,
  getValueAtPath,
} from '@/components/sessions/actions/ActionInputFields';
import { useInputFieldOptions } from '@/components/sessions/actions/useInputFieldOptions';
import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { readProjectRepositoryIdentityV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { t } from '@/text';

import { readDeploymentActionError, readDeploymentRefusal } from './deploymentActionOutcome';
import type { createDeploymentActions } from './deploymentActions';
import { DeploymentPlatformInspectState } from './DeploymentPlatformInspectState';
import {
  buildPlatformTargetDraft,
  buildPlatformTargetLinkInput,
  readDeploymentPlatformTargets,
  readPlatformInspectOutcome,
  type DeploymentPlatformTarget,
  type PlatformInspectOutcome,
  applyPlatformFieldPatch,
  disclosePlatformFields,
} from './platformTargetLink';

type Actions = ReturnType<typeof createDeploymentActions>;
export type DeploymentPlatformLinkActions = Pick<
  Actions,
  'inspectPlatformTarget' | 'link'
>;

export type DeploymentPlatformTargetSheetInput = Readonly<{
  name: string;
  environment: Readonly<{
    id: string;
    revision: number;
    projectSourceId: string;
  }>;
  ownerAccountId: string;
  lifetime: ServerAccountScopeLifetime;
  actions: DeploymentPlatformLinkActions;
  /** A held approval continues on the page's one approval handle. */
  onApproval: (artifactId: string) => void;
  /** The platform already chosen in the draft, so the person never picks it twice. */
  initialTargetKey?: string | null;
}>;

type PlatformTargetsState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'ready'; targets: readonly DeploymentPlatformTarget[] }>
  | Readonly<{ status: 'failed'; code: string }>;

/** The plugins' own deployment targets, loaded only while a draft or this sheet asks for them. */
export function useDeploymentPlatformTargets(lifetime: ServerAccountScopeLifetime | null) {
  const [state, setState] = React.useState<PlatformTargetsState>({
    status: 'loading',
  });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (!lifetime) return;
    let live = true;
    setState((previous) =>
      previous.status === 'ready' ? previous : { status: 'loading' },
    );
    readPluginAccountAvailability(lifetime.scope)
      .ensureCurrentAccountExecutionDeclarations({
        family: 'deploymentTargets',
      })
      .then((result) => {
        if (!live) return;
        setState(
          result.kind === 'available'
            ? {
                status: 'ready',
                targets: readDeploymentPlatformTargets(result.declarations),
              }
            : { status: 'failed', code: result.code },
        );
      })
      .catch((error: unknown) => {
        const code = (error as { code?: unknown } | null)?.code;
        if (live)
          setState({
            status: 'failed',
            code: typeof code === 'string' && code ? code : 'unknown_error',
          });
      });
    return () => {
      live = false;
    };
  }, [lifetime, attempt]);
  return {
    state,
    retry: React.useCallback(() => setAttempt((value) => value + 1), []),
  };
}

type PlatformTargetSource = Readonly<{ contribution: Readonly<{ pluginId: string; localId: string }> }>;
const NO_TITLES: ReadonlyMap<string, string> = new Map();
const titleKey = (pluginId: string, localId: string) => `${pluginId}/${localId}`;

/**
 * Platform targets' own names (Vercel, Cloudflare Pages), read once from the Account's deployment-target
 * declarations while `wanted`. Every Environment row, header and Settings row names its platform through this.
 */
export function useDeploymentPlatformTargetTitles(lifetime: ServerAccountScopeLifetime | null, wanted: boolean) {
  const [titles, setTitles] = React.useState<ReadonlyMap<string, string>>(NO_TITLES);
  React.useEffect(() => {
    if (!lifetime || !wanted) return;
    let live = true;
    void readPluginAccountAvailability(lifetime.scope)
      .ensureCurrentAccountExecutionDeclarations({ family: 'deploymentTargets' })
      .then((result) => {
        if (!live || result.kind !== 'available') return;
        setTitles(new Map(readDeploymentPlatformTargets(result.declarations)
          .map((target) => [titleKey(target.pluginId, target.targetId), target.title])));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [lifetime, wanted]);
  return React.useCallback(
    (source: PlatformTargetSource) => titles.get(titleKey(source.contribution.pluginId, source.contribution.localId)) ?? null,
    [titles],
  );
}

const EMPTY_VALUES: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * Add a platform target (Environment → Servers & build, Overview, or right after a platform draft is created):
 * choose a target from the plugins' declarations, the connected account it uses, and the project, environment
 * and product through the provider's own choices. Check reads the provider only; Link records exactly what the
 * check returned. Linking deploys nothing; the next Deploy does.
 */
function DeploymentPlatformTargetSheet(
  props: DeploymentPlatformTargetSheetInput & CustomModalInjectedProps,
) {
  const { state: platformsState, retry: retryPlatforms } =
    useDeploymentPlatformTargets(props.lifetime);
  const targets =
    platformsState.status === 'ready' ? platformsState.targets : [];
  const [targetKey, setTargetKey] = React.useState<string | null>(props.initialTargetKey ?? null);
  const target =
    targets.find((entry) => entry.key === targetKey) ??
    targets[0] ??
    null;
  const [platformMenuOpen, setPlatformMenuOpen] = React.useState(false);
  const [account, setAccount] =
    React.useState<QualifiedConnectedAccountRef | null>(null);
  const [values, setValues] =
    React.useState<Readonly<Record<string, unknown>>>(EMPTY_VALUES);
  // One page of choices per field; Previous walks back the cursors this field was asked with.
  const [cursors, setCursors] = React.useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  const [outcome, setOutcome] = React.useState<PlatformInspectOutcome | null>(
    null,
  );
  const [busy, setBusy] = React.useState<'check' | 'link' | null>(null);
  const [linkRefused, setLinkRefused] = React.useState<string | null>(null);
  const source =
    useProjectSource(props.lifetime, props.environment.projectSourceId).source
      ?.source ?? null;
  const repository = React.useMemo(
    () => readProjectRepositoryIdentityV1({ source }),
    [source],
  );

  const draft = React.useMemo(
    () =>
      target && account
        ? buildPlatformTargetDraft({
            target,
            ownerAccountId: props.ownerAccountId,
            serverId: props.lifetime.scope.serverId,
            environment: props.environment,
            account,
            repository,
            values,
          })
        : null,
    [
      target,
      account,
      props.ownerAccountId,
      props.lifetime.scope.serverId,
      props.environment,
      repository,
      values,
    ],
  );
  const fields = React.useMemo(
    () =>
      target
        ? disclosePlatformFields(
            resolveEffectiveActionInputFields(
              { inputHints: { fields: [...target.fields] } },
              values,
            ),
            values,
          )
        : [],
    [target, values],
  );
  const requests = React.useMemo(
    () =>
      target && draft
        ? fields.map((field) => {
            const cursor = cursors[field.path]?.at(-1);
            return {
              field,
              actionId: target.inspectActionId,
              draftInput: draft,
              ...(cursor ? { cursor } : {}),
            };
          })
        : [],
    [target, draft, fields, cursors],
  );
  const options = useInputFieldOptions({
    requests,
    enabled: draft !== null,
    serverId: props.lifetime.scope.serverId,
    accountLifetime: props.lifetime,
  });
  // A choice with nothing to pick yet (it waits on the one above it) is not drawn; required ones always are.
  const visibleFields = fields.filter((field) => {
    if (field.required || getValueAtPath(values, field.path) !== undefined)
      return true;
    const choices = options.state(field);
    return (
      choices.status !== 'ready' ||
      choices.options.length > 0 ||
      (cursors[field.path]?.length ?? 0) > 0
    );
  });
  const missing = fields.some(
    (field) =>
      field.required && getValueAtPath(values, field.path) === undefined,
  );

  const resetFrom = React.useCallback(() => {
    setOutcome(null);
    setLinkRefused(null);
  }, []);
  const choosePlatform = (id: string) => {
    setPlatformMenuOpen(false);
    if (id === target?.key) return;
    setTargetKey(id);
    setAccount(null);
    setValues(EMPTY_VALUES);
    setCursors({});
    resetFrom();
  };
  const patch = (next: Record<string, unknown>) => {
    const { values: kept, changedIndex: changed } = applyPlatformFieldPatch(fields, values, next);
    setValues(kept);
    setCursors((current) =>
      changed === -1
        ? current
        : Object.fromEntries(
            Object.entries(current).filter(
              ([path]) =>
                fields.findIndex((field) => field.path === path) <= changed,
            ),
          ),
    );
    resetFrom();
  };
  const page = (
    field: EffectiveActionInputField,
    direction: 'next' | 'previous',
  ) => {
    const nextCursor = options.state(field).nextCursor;
    setCursors((current) => {
      const stack = current[field.path] ?? [];
      const next =
        direction === 'next'
          ? nextCursor
            ? [...stack, nextCursor]
            : stack
          : stack.slice(0, -1);
      return { ...current, [field.path]: next };
    });
  };

  const { onClose, onApproval, actions } = props;
  const check = async () => {
    if (!target || !draft || busy) return;
    setBusy('check');
    setLinkRefused(null);
    const result = await actions.inspectPlatformTarget(
      target.inspectActionId,
      draft,
    );
    setBusy(null);
    setOutcome(readPlatformInspectOutcome(result));
  };
  const link = async () => {
    if (!target || outcome?.kind !== 'ready' || busy) return;
    setBusy('link');
    setLinkRefused(null);
    try {
      const result = await actions.link(
        buildPlatformTargetLinkInput({
          target,
          environment: props.environment,
          provider: outcome.provider,
        }),
        // This sheet is the person's confirmation of the exact Link.
        { presentUserConfirmation: { actionId: 'deployments.targets.link' } },
      );
      if (result.ok) {
        onClose();
        return;
      }
      setLinkRefused(
        'error' in result && typeof result.error === 'string'
          ? result.error
          : 'unknown_error',
      );
    } catch (error) {
      const read = readDeploymentActionError(error);
      if (read.kind === 'approval') {
        onClose();
        onApproval(read.artifactId);
        return;
      }
      setLinkRefused(read.kind === 'refused' ? read.code : 'unknown_error');
    } finally {
      setBusy(null);
    }
  };

  const platformItems = React.useMemo(
    (): DropdownMenuItem[] =>
      targets.map((entry) => ({
        id: entry.key,
        title: entry.title,
        checked: entry.key === target?.key,
        disabled: busy !== null,
      })),
    [targets, target?.key, busy],
  );

  const ready = outcome?.kind === 'ready';
  const footer = (
    <ModalCardFooterActions cancel={{ onPress: onClose, testID: 'project-deployments.platform.cancel', disabled: busy !== null }}>
      <RoundButton
        testID={
          ready
            ? 'project-deployments.platform.link'
            : 'project-deployments.platform.check'
        }
        size="normal"
        loading={busy !== null}
        disabled={busy !== null || !draft || !target || missing}
        title={
          ready && target
            ? t('projects.deployments.platformLink.link', {
                platform: target.title,
              })
            : outcome
              ? t('projects.deployments.platformLink.checkAgain')
              : t('projects.deployments.platformLink.check')
        }
        onPress={() => {
          void (ready ? link() : check());
        }}
      />
    </ModalCardFooterActions>
  );
  const { setChrome } = props;
  React.useEffect(() => {
    setChrome?.({ kind: 'card', footer });
  });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);

  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <View testID="project-deployments.platform" style={deploymentSheetStyles.body}>
        <Text style={deploymentSheetStyles.lead}>
          {t('projects.deployments.platformLink.lead')}
        </Text>
        {platformsState.status === 'loading' ? (
          <SurfaceStateCard
            testID="project-deployments.platform.loading"
            size="line"
            kind="loading"
            title={t('projects.deployments.platformLink.loading')}
          />
        ) : platformsState.status === 'failed' ? (
          <SurfaceStateCard
            testID="project-deployments.platform.failed"
            size="line"
            kind="error"
            title={t('projects.deployments.platformLink.failed')}
            diagnosticCode={platformsState.code}
            action={{ label: t('common.retry'), onPress: retryPlatforms }}
          />
        ) : !target ? (
          <SurfaceStateCard
            testID="project-deployments.platform.empty"
            size="line"
            kind="empty"
            title={t('projects.deployments.platformLink.empty')}
            reason={t('projects.deployments.platformLink.emptyBody')}
          />
        ) : (
          <>
            <ItemGroup header="none">
              <DropdownMenu
                testID="project-deployments.platform.choice"
                open={platformMenuOpen}
                onOpenChange={setPlatformMenuOpen}
                items={platformItems}
                selectedId={target.key}
                onSelect={choosePlatform}
                itemTrigger={{
                  title: t('projects.deployments.platformLink.platform'),
                  showSelectedSubtitle: false,
                  itemProps: { disabled: busy !== null },
                }}
              />
              <ConnectedAccountPurposeTargetChooser
                key={target.key}
                testID="project-deployments.platform.account"
                localizedTextPluginId={target.service.pluginId}
                declaration={{
                  purpose: target.purpose,
                  service: target.service,
                  required: true,
                }}
                value={account ? { kind: 'account', account } : null}
                accountsOnly
                disabled={busy !== null}
                onChange={(next) => {
                  setAccount(next?.kind === 'account' ? next.account : null);
                  setValues(EMPTY_VALUES);
                  setCursors({});
                  resetFrom();
                }}
              />
              {/* Each provider choice is a row of the same sheet: the row names it, the control draws no label. */}
              {draft
                ? visibleFields.map((field) => {
                    const more = options.state(field).nextCursor !== undefined;
                    const back = (cursors[field.path]?.length ?? 0) > 0;
                    return (
                      <React.Fragment key={field.path}>
                        <Item
                          testID={`project-deployments.platform.row:${field.path}`}
                          title={field.title ?? field.path}
                          showChevron={false}
                          accessoryLayout="adaptive"
                          rightElement={
                            <ActionInputFields
                              fields={[field]}
                              input={values as Record<string, unknown>}
                              editable={busy === null}
                              busy={busy !== null}
                              frame="none"
                              resolveFieldOptions={options.resolveOptions}
                              resolveFieldTestID={(entry) =>
                                `project-deployments.platform.field:${entry.path}`
                              }
                              onPatch={patch}
                            />
                          }
                        />
                        {more || back ? (
                          <View style={styles.paging}>
                            {back ? (
                              <SectionActionButton
                                testID={`project-deployments.platform.previous:${field.path}`}
                                title={t('projects.deployments.pagePrevious')}
                                icon="caret-left"
                                onPress={() => page(field, 'previous')}
                              />
                            ) : null}
                            {more ? (
                              <SectionActionButton
                                testID={`project-deployments.platform.next:${field.path}`}
                                title={t('projects.deployments.pageNext')}
                                icon="caret-right"
                                onPress={() => page(field, 'next')}
                              />
                            ) : null}
                          </View>
                        ) : null}
                      </React.Fragment>
                    );
                  })
                : null}
            </ItemGroup>
            <DeploymentPlatformInspectState outcome={outcome} />
            {linkRefused ? (
              <SurfaceStateCard
                testID="project-deployments.platform.linkRefused"
                size="line"
                kind="error"
                title={t('projects.deployments.platformLink.linkRefused')}
                reason={readDeploymentRefusal(linkRefused).reason === 'permission'
                  ? t('projects.deployments.platformLink.managersOnly')
                  : t('projects.deployments.nothingChanged')}
                diagnosticCode={linkRefused}
              />
            ) : null}
          </>
        )}
        {/* Without card chrome (an embedding host), the footer ends the body. */}
        {setChrome ? null : footer}
      </View>
    </ListPresentationProvider>
  );
}

export function showDeploymentPlatformTargetSheet(
  input: DeploymentPlatformTargetSheetInput,
): void {
  showDeploymentSheet({
    component: DeploymentPlatformTargetSheet,
    props: input,
    title: t('projects.deployments.platformLink.title', { name: input.name }),
    testID: 'project-deployments.platform.modal',
  });
}

const styles = StyleSheet.create((theme) => ({
  paging: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s8,
  },
}));
