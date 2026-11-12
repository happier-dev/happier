import * as React from 'react';
import { ScmPullRequestReferenceSchema, type ScmPullRequestSummary } from '@happier-dev/protocol/scm/pullRequests';
import { type DeploymentSourceIntentV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { GitPullRequestProviderMark } from '@/components/sessions/panes/git/pullRequest/GitPullRequestProviderMark';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Typography } from '@/constants/Typography';
import { useOpenResource } from '@/utils/url/openResource';
import { deploymentRevisionLabel } from './deploymentPresentation';
import { machineScmPullRequestGet } from '@/sync/ops/scm/machineScm';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';
import { DeploymentSourceCheckoutRow, useOwnSourceCheckout } from './DeploymentSourceCheckoutRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { getScmUserFacingError } from '@/scm/scmUserFacingErrors';

type RepositorySource = Extract<DeploymentSourceIntentV1, { kind: 'repository' }>;
/** The SCM reader selects the displayed head. Deploy admission still fetches and verifies that exact base-repository PR head. */
export function DeploymentPullRequestDeploy(props: Readonly<{
  workspaceRef?: WorkspaceRefV1 | null;
  projectSourceId: string;
  sourceRevision: number | null;
  compose: RepositorySource['compose'];
  serverId: string;
  accountId: string;
  disabled: boolean;
  onDeploy(source: RepositorySource): Promise<void>;
}>) {
  const ownCheckout = useOwnSourceCheckout(props.projectSourceId, props.serverId);
  const { openResource } = useOpenResource({ serverId: props.serverId });
  const [reference, setReference] = React.useState('');
  const [candidate, setCandidate] = React.useState<Readonly<{ pullRequest: ScmPullRequestSummary; source: RepositorySource | null }> | null>(null);
  const [pending, setPending] = React.useState(false);
  /** The number a successful read found no pull request for. */
  const [notFoundNumber, setNotFoundNumber] = React.useState<number | null>(null);
  const [readFailure, setReadFailure] = React.useState<string | null>(null);
  const read = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => read.current?.abort(), []);
  const workspace = props.workspaceRef;
  const parsedReference = ScmPullRequestReferenceSchema.safeParse({ number: Number(reference) });
  const exactSource = candidate?.source ?? null;
  const pullRequest = candidate?.pullRequest ?? null;
  const load = async () => {
    if (!workspace || !parsedReference.success) return;
    const requestedNumber = Number(reference);
    const abort = new AbortController();
    read.current = abort;
    setPending(true);
    setNotFoundNumber(null);
    setReadFailure(null);
    try {
      const result = await machineScmPullRequestGet(workspace.machineId, { cwd: workspace.rootPath, prReference: parsedReference.data },
        { serverId: props.serverId, accountId: props.accountId, signal: abort.signal });
      if (abort.signal.aborted) return;
      const pullRequest = result.success ? result.pullRequest : null;
      const source: RepositorySource | null = pullRequest?.headSha && pullRequest.number && props.sourceRevision !== null ? {
        kind: 'repository', projectSourceId: props.projectSourceId, sourceRevision: props.sourceRevision,
        sha: pullRequest.headSha, pullRequestHead: { number: pullRequest.number }, ...(props.compose ? { compose: props.compose } : {}),
      } : null;
      setCandidate(pullRequest ? { pullRequest, source } : null);
      if (result.success) {
        setNotFoundNumber(result.pullRequest === null ? requestedNumber : null);
        setReadFailure(null);
      } else {
        setNotFoundNumber(null);
        setReadFailure(getScmUserFacingError({ errorCode: result.errorCode, error: result.error,
          fallback: t('projects.deployments.editors.prUnavailable'), subject: 'pullRequest' }));
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        setCandidate(null);
        setNotFoundNumber(null);
        setReadFailure(getScmUserFacingError({ error: error instanceof Error ? error.message : undefined,
          fallback: t('projects.deployments.editors.prUnavailable'), subject: 'pullRequest' }));
      }
    }
    finally { if (!abort.signal.aborted) setPending(false); }
  };
  // Reading the head is an operation beside its field; the pull request it finds is a row of this sheet, not a card in it.
  return <ItemGroup testID="project-deployments.pr" title={t('projects.deployments.editors.pullRequest')}>
    {workspace ? <>
      <Item title={t('projects.deployments.editors.pullRequestNumber')} accessoryLayout="stacked" showChevron={false}
        rightElement={<View style={styles.read}>
          <View style={styles.number}>
            <FieldTextInput testID="project-deployments.pr.number" accessibilityLabel={t('projects.deployments.editors.pullRequestNumber')}
              value={reference} keyboardType="number-pad" editable={!pending}
              onChangeText={value => { setReference(value); setCandidate(null); setNotFoundNumber(null); setReadFailure(null); }} />
          </View>
          <RoundButton testID="project-deployments.pr.load" size="small" display="secondary" title={t('projects.deployments.editors.loadPrHead')}
            loading={pending} disabled={pending || !parsedReference.success} onPress={() => { void load(); }} />
        </View>} />
      {pullRequest ? <Item testID="project-deployments.pr.summary" title={pullRequest.title}
        // The provider mark rides the facts line, so the section keeps one title edge before and after the read.
        subtitleLeading={<GitPullRequestProviderMark kind={pullRequest.provider.kind} size={14} />}
        subtitle={[pullRequest.number ? t('sessionGitPullRequest.card.number', { number: pullRequest.number }) : null,
          t(`sessionGitPullRequest.card.state.${pullRequest.state}` as const),
          pullRequest.baseBranch ? t('sessionGitPullRequest.card.intoBase', { base: pullRequest.baseBranch }) : null].filter(Boolean).join(' · ')}
        showChevron={false} rightElement={<RoundButton testID="project-deployments.pr.open" size="small" display="secondary"
          title={t('common.open')} onPress={() => { void openResource({ kind: 'pullRequest', url: pullRequest.url }); }} />} /> : null}
      {pullRequest?.headSha ? <Item testID="project-deployments.pr.head" title={t('projects.deployments.editors.prHead')}
        subtitle={deploymentRevisionLabel({ kind: 'repository', sha: pullRequest.headSha })} subtitleStyle={styles.sha} showChevron={false}
        rightElement={<RoundButton testID="project-deployments.pr.deploy" size="small" display="secondary"
          title={t('projects.deployments.editors.deployPrHead')} disabled={props.disabled || pending || exactSource === null}
          onPress={() => { if (exactSource) void props.onDeploy(exactSource); }} />} /> : null}
      {readFailure ? <SurfaceStateCard testID="project-deployments.pr.unavailable" size="line" kind="error" title={readFailure} /> : null}
      {notFoundNumber !== null ? <SurfaceStateCard testID="project-deployments.pr.empty" size="line" kind="empty"
        title={t('projects.deployments.editors.prNotFound', { number: notFoundNumber })} /> : null}
      {candidate && exactSource === null ? <SurfaceStateCard testID="project-deployments.pr.sourceUnavailable" size="line" kind="unavailable"
        title={t('projects.deployments.editors.prUnavailable')} /> : null}
    </> : <DeploymentSourceCheckoutRow testID="project-deployments.pr.checkout" projectSourceId={props.projectSourceId}
      serverId={props.serverId} checkout={ownCheckout} needsCheckout={t('projects.deployments.editors.prNeedsCheckout')} />}
  </ItemGroup>;
}

const styles = StyleSheet.create((theme) => ({
  read: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  number: { flex: 1, minWidth: 0 },
  sha: Typography.mono(),
}));
