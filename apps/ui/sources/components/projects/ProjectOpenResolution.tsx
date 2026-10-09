import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces';
import type { WorkspaceRefResolutionV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useAllMachines } from '@/sync/domains/state/storage';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';

import { resolveWorkspaceRefDisplayName } from './resolveWorkspaceRefDisplayName';
import { useOpenProject } from './useOpenProject';

/** An open that did not name exactly one saved checkout (`useOpenProject().resolution`). */
export type ProjectOpenIssue = Exclude<
  WorkspaceRefResolutionV1,
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
    }>,
  ) {
    const testID = props.testID ?? 'project-open-resolution';
    const machines = useAllMachines();
    const describe = React.useCallback(
      (candidate: WorkspaceRefV1) => {
        const machine =
          machines.find((entry) => entry.id === candidate.machineId) ?? null;
        const machineName =
          (machine ? getMachineDisplayName(machine) : null) ??
          candidate.machineId;
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
): boolean {
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
  props: Readonly<{ resolution: WorkspaceRefResolutionV1 | undefined }>,
) {
  const router = useRouter();
  const openProject = useOpenProject();
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
        />
      </View>
    </ItemList>
  );
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
