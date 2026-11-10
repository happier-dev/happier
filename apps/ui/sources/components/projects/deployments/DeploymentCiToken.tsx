import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { renderDeploymentGithubActionsStep } from '@happier-dev/deployments';
import { API_TOKEN_ENVIRONMENT_ACTION_IDS_V1, API_TOKEN_FULL_GRANT_V1, isApiTokenDeploymentGrantV1,
  resolveApiTokenDeploymentGrantV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { AccountApiTokenSummaryV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ApiTokenCreateModal } from '@/components/settings/apiTokens/ApiTokenCreateModal';
import { ApiTokenRow } from '@/components/settings/apiTokens/ApiTokenRow';
import { apiTokenRowHref } from '@/components/settings/apiTokens/collection/apiTokensCollection';
import { createApiTokenSettingsController, type ApiTokenSettingsController } from '@/components/settings/apiTokens/apiTokenSettingsController';
import { resolveApiTokenOperationErrorMessageKey } from '@/components/settings/apiTokens/apiTokenSettingsPresentation';
import { createApiTokenModalLifecycle } from '@/components/settings/apiTokens/showApiTokenCreateModal';
import { useApiTokenGrantNames } from '@/components/settings/apiTokens/grant/useApiTokenGrantCatalogs';
import { useApiTokenSettingsClock } from '@/components/settings/apiTokens/useApiTokenSettingsClock';
import { useApiTokenSettingsControllerState } from '@/components/settings/apiTokens/useApiTokenSettingsControllerState';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

export type DeploymentCiInput = Readonly<{
  environmentId: string; name: string; protection: 'production' | 'nonProduction';
  serverIdentityId: string; serverApiUrl: string; scope: ServerAccountScope; lifetime: ServerAccountScopeLifetime;
}>;

const styles = StyleSheet.create(theme => ({
  body: { paddingHorizontal: theme.space.s20, paddingBottom: theme.space.s24 },
  step: { gap: theme.space.s12 },
  hint: { ...Typography.variant('body'), color: theme.colors.text.secondary },
  code: { ...Typography.mono(), color: theme.colors.text.primary },
}));

/** The token owner mints, reveals once, lists and revokes; this entry supplies only its exact preset. */
export function showDeploymentCiTokenSheet(input: DeploymentCiInput): void {
  const controller = createApiTokenSettingsController(undefined, input.lifetime);
  controller.setCreateDraft({ ...controller.getState().createDraft, label: `${input.name} CI`, access: 'limited',
    grant: resolveApiTokenDeploymentGrantV1({ ...API_TOKEN_FULL_GRANT_V1,
      actions: { families: [], ids: [...API_TOKEN_ENVIRONMENT_ACTION_IDS_V1] },
      targets: { sessions: [], machines: [], environments: [input.environmentId] },
    }, { environmentId: input.environmentId, deployApproval: input.protection === 'production' ? 'ask' : 'automatic' }) });
  Modal.show({ component: DeploymentCiSheet, props: { input, controller }, closeOnBackdrop: true,
    ...createApiTokenModalLifecycle(controller, Modal, controller.retire) });
}

export function DeploymentCiSheet(props: Readonly<{ input: DeploymentCiInput; controller: ApiTokenSettingsController }> & CustomModalInjectedProps) {
  const state = useApiTokenSettingsControllerState(props.controller);
  const [creating, setCreating] = React.useState(false);
  React.useEffect(() => { void props.controller.refresh(); }, [props.controller]);
  const tokens = React.useMemo(() => state.tokens.filter(token => isApiTokenDeploymentGrantV1(token.grant)
    && token.grant.targets?.environments?.[0] === props.input.environmentId), [props.input.environmentId, state.tokens]);
  return <View testID="project-deployments.environment.ci.sheet">
    {creating || state.reveal || state.phase === 'ready' && tokens.length === 0 ? (
      <ApiTokenCreateModal controller={props.controller} deploymentTitle={props.input.name}
        onClose={props.onClose} setChrome={props.setChrome} revealAccessory={<DeploymentCiStep input={props.input} controller={props.controller} />} />
    ) : <DeploymentCiSummary {...props} tokens={tokens} onCreate={() => setCreating(true)} />}
  </View>;
}

function DeploymentCiStep(props: Readonly<{ input: DeploymentCiInput; controller: ApiTokenSettingsController }>) {
  const state = useApiTokenSettingsControllerState(props.controller);
  const copy = useClipboardWrite(props.input.scope);
  const step = React.useMemo(() => renderDeploymentGithubActionsStep(props.input), [props.input]);
  const checking = state.encryptionAvailability === 'unchecked' || state.encryptionAvailability === 'checking';
  const unreadable = state.encryptionAvailability === 'unreadable';
  if (state.encryptionAvailability !== 'plain') return <SurfaceStateCard size="line"
    kind={checking ? 'loading' : unreadable ? 'error' : 'unavailable'}
    title={checking ? t('common.loading') : unreadable ? t(resolveApiTokenOperationErrorMessageKey('unavailable'))
      : t('projects.deployments.overviewStatus.ciClientRequired')}
    diagnosticCode={checking || unreadable ? undefined : 'client_required'}
    action={{ label: t('common.retry'), onPress: () => { void props.controller.refreshEncryptionAvailability(); } }} />;
  return <View style={styles.step}>
    <Text style={styles.hint}>{t('projects.deployments.overviewStatus.ciStepHint')}</Text>
    <Text selectable style={styles.code} testID="project-deployments.environment.ci.step">{step}</Text>
    <RoundButton size="normal" display="inverted" title={t('projects.deployments.overviewStatus.ciCopyStep')}
      action={async () => { await copy(step); }} />
  </View>;
}

function DeploymentCiSummary(props: Readonly<{ input: DeploymentCiInput; controller: ApiTokenSettingsController;
  tokens: readonly AccountApiTokenSummaryV1[]; onCreate(): void }> & CustomModalInjectedProps) {
  const state = useApiTokenSettingsControllerState(props.controller);
  const names = useApiTokenGrantNames();
  const nowMs = useApiTokenSettingsClock(props.tokens, true);
  const router = useRouter();
  const onOpen = React.useCallback((token: AccountApiTokenSummaryV1) => {
    props.onClose(); router.push(apiTokenRowHref(token));
  }, [props.onClose, router]);
  const footer = React.useMemo(() => <RoundButton size="normal" title={t('settingsApiTokens.create.submit')}
    disabled={state.phase !== 'ready'} onPress={props.onCreate} />, [props.onCreate, state.phase]);
  useModalCardChrome(props.setChrome, React.useMemo(() => ({ kind: 'card' as const,
    title: t('projects.deployments.overviewStatus.ciTitle'), subtitle: props.input.name,
    testID: 'project-deployments.environment.ci.modal', phonePresentation: 'sheet' as const,
    scrollHost: 'body' as const, dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.9, size: 'md' as const }, footer,
  }), [footer, props.input.name]));
  return <ScrollView contentContainerStyle={styles.body}>
    <ListPresentationProvider value="page" pageInsets="contained">
      <ItemGroup description={t('projects.deployments.overviewStatus.ciAuthority')}>
        {props.tokens.map(token => <ApiTokenRow key={token.tokenId} token={token} names={names} nowMs={nowMs} variant="page" onPress={onOpen} />)}
        {state.phase === 'idle' || state.phase === 'loading' ? <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} /> : null}
        {state.listError ? <SurfaceStateCard size="line" kind="error" title={t(resolveApiTokenOperationErrorMessageKey(state.listError))}
          action={{ label: t('common.retry'), onPress: () => { void props.controller.refresh(); } }} /> : null}
      </ItemGroup>
      {state.phase === 'ready' ? <DeploymentCiStep input={props.input} controller={props.controller} /> : null}
    </ListPresentationProvider>
  </ScrollView>;
}
