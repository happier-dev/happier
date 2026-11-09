import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces';
import type { WorkspaceRefResolutionV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceRefUnconfirmed } from './detail/useWorkspaceRefById';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useActiveServerAccountScope, useActiveMachineFacts } from '@/sync/domains/state/storage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';

import { resolveWorkspaceRefDisplayName } from './resolveWorkspaceRefDisplayName';
import { useOpenProject } from './useOpenProject';

/** The rows are still being read (a ready but partial census is still reading its remaining rows). */
export function isProjectRowsPending(issue: WorkspaceRefUnconfirmed): boolean {
  return issue.status === 'idle' || issue.status === 'loading' || issue.status === 'ready';
}

/**
 * An open that did not name exactly one saved checkout (`useOpenProject().resolution`), or one the
 * Project rows have not confirmed yet (still loading, failed, locked or partial).
 */
export type ProjectOpenIssue = Exclude<
  WorkspaceRefResolutionV1 | WorkspaceRefUnconfirmed,
  { kind: 'resolved' }
>;

/**
 * What an open that could not pick one checkout says (lab p-projects OPEN_S 2): more than one saved
 * checkout matches, so each is offered with its machine and path and the person chooses; nothing is
 * merged or picked for them. A missing or malformed target says so and offers the way back instead of
 * guessing a neighbour. `onChoose` receives the exact candidate; the caller opens its qualified address.
 */
export const ProjectOpenResolutionCard = React.memo(
  function ProjectOpenResolutionCard(
    props: Readonly<{
      testID?: string;
      issue: ProjectOpenIssue;
      onChoose: (candidate: WorkspaceRefV1) => void;
      /** The one way forward when nothing can be chosen (dismiss in a list, back to Projects on a page). */
      action?: Readonly<{ label: string; onPress: () => void }>;
      /** A centred page state (deep link) rather than an inline notice in a list. */
      page?: boolean;
      /** One line between a column's rows (the Projects column), rather than a card. */
      line?: boolean;
      /** Read the Project rows again (an unconfirmed checkout whose read failed). */
      onRetry?: () => void;
    }>,
  ) {
    const testID = props.testID ?? 'project-open-resolution';
    const machines = useActiveMachineFacts();
    const describe = React.useCallback(
      (candidate: WorkspaceRefV1) => {
        const machine =
          machines.find((entry) => entry.id === candidate.machineId) ?? null;
        // Candidates are told apart by their Machine's name from the naming owner, never its raw id.
        const machineName = getMachineDisplayName(
          machine ?? { id: candidate.machineId, absence: 'unlisted' },
          machines,
        );
        return `${machineName} · ${formatPathRelativeToHome(candidate.rootPath, machine?.metadata?.homeDir ?? undefined)}`;
      },
      [machines],
    );
    const layout = props.page ? 'centered' : 'inline';
    const action = props.action
      ? {
          label: props.action.label,
          onPress: props.action.onPress,
          testID: `${testID}-action`,
        }
      : undefined;

    if (props.issue.kind === 'unconfirmed') {
      // Not known to be gone: the rows have not loaded yet, or the read failed. Say which, keep the
      // address, and offer the read again; never "isn't saved here anymore".
      // A ready but partial census is still reading its remaining rows.
      const pending = isProjectRowsPending(props.issue);
      return (
        <SurfaceStateCard
          testID={testID}
          kind={pending ? 'loading' : 'unavailable'}
          layout={layout}
          {...(props.line ? { size: 'line' as const } : {})}
          title={pending ? t('projects.identity.rowsLoadingTitle') : t('projects.identity.rowsUnavailableTitle')}
          reason={pending ? undefined : t('projects.identity.rowsUnavailableBody')}
          accessibilitySemantics="status"
          action={pending || !props.onRetry ? undefined : {
            label: t('common.retry'),
            onPress: props.onRetry,
            testID: `${testID}-retry`,
          }}
          secondaryAction={pending ? undefined : action}
        />
      );
    }

    if (props.issue.kind === 'ambiguous') {
      const candidates = props.issue.candidates;
      return (
        <SurfaceStateCard
          testID={testID}
          kind="warning"
          layout={layout}
          title={t('projects.identity.openAmbiguousTitle')}
          reason={t('projects.identity.openAmbiguousBody')}
          accessibilitySemantics="status"
          body={
            <View style={styles.candidates}>
              {candidates.map((candidate, index) => (
                <Item
                  key={`${candidate.serverId}\u0000${candidate.machineId}\u0000${candidate.rootPath}\u0000${index}`}
                  testID={`${testID}-candidate-${index}`}
                  title={resolveWorkspaceRefDisplayName(candidate)}
                  subtitle={describe(candidate)}
                  icon={<Icon name="folder" />}
                  showChevron
                  onPress={() => props.onChoose(candidate)}
                />
              ))}
            </View>
          }
          secondaryAction={action}
        />
      );
    }

    return (
      <SurfaceStateCard
        testID={testID}
        kind="unavailable"
        layout={layout}
        title={
          props.issue.kind === 'missing'
            ? t('projects.identity.openMissingTitle')
            : t('projects.identity.openInvalidTitle')
        }
        reason={
          props.issue.kind === 'missing'
            ? t('projects.identity.openMissingBody')
            : t('projects.identity.openInvalidBody')
        }
        diagnosticCode={
          props.issue.kind === 'invalid' ? props.issue.reason : null
        }
        accessibilitySemantics="status"
        action={action}
      />
    );
  },
);

/** The exact open of a chosen candidate: its qualified address, never the bare id it shared. */
export function openProjectCandidate(
  openProject: ReturnType<typeof useOpenProject>,
  candidate: WorkspaceRefV1,
): Promise<boolean | null> {
  return openProject(candidate.id, {
    serverId: candidate.serverId,
    workspaceAddress: workspaceAddressFromRefV1(candidate),
  });
}

/**
 * A Project deep link that names no single checkout (`ProjectDetailScreen.workspaceResolution`):
 * mounted only in that state, so the opening hooks never run beside a resolved Project.
 */
export function ProjectOpenResolutionPage(
  props: Readonly<{ resolution: WorkspaceRefResolutionV1 | WorkspaceRefUnconfirmed | undefined }>,
) {
  const router = useRouter();
  const openProject = useOpenProject();
  const retry = useProjectRowsRetry();
  const issue: ProjectOpenIssue =
    props.resolution && props.resolution.kind !== 'resolved'
      ? props.resolution
      : { kind: 'missing' };
  return (
    <ItemList testID="project-open-resolution-page">
      <View style={styles.page}>
        <ProjectOpenResolutionCard
          page
          issue={issue}
          onChoose={(candidate) => {
            openProjectCandidate(openProject, candidate);
          }}
          action={{
            label: t('projects.identity.backToProjects'),
            onPress: () => router.push('/projects'),
          }}
          onRetry={retry}
        />
      </View>
    </ItemList>
  );
}

/**
 * A refresh that failed over Project rows the surface still shows (`model.staleRows`): the rows stay at full
 * strength under this one line, labeled as of the last read, with Retry. Retry shows itself pending and leaves
 * only when a read of this scope succeeds.
 */
export function ProjectRowsStaleLine(props: Readonly<{ testID: string; asOf: number | null }>) {
  const retry = useProjectRowsRetry();
  const [retrying, setRetrying] = React.useState(false);
  const onRetry = React.useCallback(() => {
    setRetrying(true);
    void retry().finally(() => setRetrying(false));
  }, [retry]);
  return (
    <SurfaceFreshnessLine
      testID={props.testID}
      asOf={props.asOf}
      reason={t('projects.identity.rowsStaleReason')}
      busy={retrying}
      action={{ label: t('common.retry'), onPress: onRetry, disabled: retrying, testID: `${props.testID}-retry` }}
    />
  );
}

/**
 * Read this Home's Project rows again through the canonical list Action (the same read every
 * surface uses), for a page whose checkout the rows have not confirmed.
 */
export function useProjectRowsRetry(): () => Promise<void> {
  const scope = useActiveServerAccountScope();
  const serverId = scope?.serverId ?? null;
  return React.useCallback(async () => {
    if (!serverId) return;
    const read = (async () => {
      const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
      await createDefaultActionExecutor().execute('projects.list', { serverId }, { surface: 'ui', serverId });
    })();
    fireAndForget(read, { tag: 'ProjectOpenResolution.retryRows' });
    // Settles either way, so a caller can show the read pending; the census owner decides what the outcome means.
    await read.catch(() => {});
  }, [serverId]);
}

const styles = StyleSheet.create(() => ({
  candidates: {
    alignSelf: 'stretch',
  },
  page: {
    paddingVertical: 32,
    paddingHorizontal: 16,
  },
}));
