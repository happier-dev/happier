import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

import { ProjectSessionDefaultsSection } from '@/components/settings/teams/defaults/TeamMemberDefaultsSection';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import {
  useProjectSessionDefaults,
  useProjectSessionDefaultsEditor,
} from '@/hooks/projects/useProjectSessionDefaults';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';

import { resolveWorkspaceRefDisplayName } from '../resolveWorkspaceRefDisplayName';

type DefaultsScope = 'me' | 'project';

/** The rows the editor shows once read (Machine, Agent, then the Agents), held while it loads (lab L11-loading). */
const LOADING_ROWS = 7;

/**
 * Project › Session defaults (plan F §2/§6, lab L11): how new sessions in this project start, for me or for
 * everyone who opens it from its shared source. One editor (the member-defaults rows plus the project's Agent
 * row), each pick saved on its own by the scope's writer; who may write the shared scope is the source
 * owner's decision, reported by the read and said on the scope line when it is no.
 */
export const ProjectSessionDefaultsBody = React.memo(
  function ProjectSessionDefaultsBody(
    props: Readonly<{
      workspaceRef: WorkspaceRefV1;
      testID?: string;
    }>,
  ) {
    const testID = props.testID ?? 'project-session-defaults';
    const { theme } = useUnistyles();
    const projectName = resolveWorkspaceRefDisplayName(props.workspaceRef);
    const projectRef = React.useMemo(() => {
      const { serverId, projectKey } = projectWorkspaceRefV1(
        props.workspaceRef,
      );
      return { serverId, projectKey };
    }, [props.workspaceRef]);
    const sourceId = props.workspaceRef.source?.sourceId ?? null;
    const sourceRef = React.useMemo(
      () =>
        sourceId ? { serverId: projectRef.serverId, sourceId } : undefined,
      [projectRef.serverId, sourceId],
    );
    const [scope, setScope] = React.useState<DefaultsScope>('me');
    const read = useProjectSessionDefaults({
      projectRef,
      ...(sourceRef ? { sourceRef } : {}),
      demanded: true,
    });
    const editor = useProjectSessionDefaultsEditor({
      read,
      scope: scope === 'me' ? 'personal-project' : 'project',
    });
    const teamName = read.data?.teamName ?? null;
    const sharedLabel = teamName
      ? t('projects.sessionDefaults.scopeTeam', { team: teamName })
      : t('projects.sessionDefaults.scopeShared');
    const tabs = React.useMemo(
      () => [
        { id: 'me' as const, label: t('projects.sessionDefaults.scopeMe') },
        { id: 'project' as const, label: sharedLabel },
      ],
      [sharedLabel],
    );
    const settled = read.status === 'ready' || read.status === 'refreshing';
    const readOnly = scope === 'project' && settled && !editor.access.editable;
    const line =
      scope === 'me'
        ? t('projects.sessionDefaults.lineMe')
        : readOnly
          ? t('projects.sessionDefaults.lineReadOnly')
          : teamName
            ? t('projects.sessionDefaults.lineTeam', {
                project: projectName,
                team: teamName,
              })
            : t('projects.sessionDefaults.lineShared', {
                project: projectName,
              });

    const scopeControl = sourceRef ? (
      <View style={{ gap: theme.space.s8, alignItems: 'flex-start' }}>
        <SegmentedTabBar
          tabs={tabs}
          activeTabId={scope}
          onSelectTab={setScope}
          testIDPrefix={`${testID}.scope`}
        />
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.space.s4,
          }}
        >
          {readOnly ? (
            <Icon
              name="lock"
              size={14}
              color={theme.colors.text.secondary}
            />
          ) : null}
          <Text
            testID={`${testID}.scopeLine`}
            variant="meta"
            style={{ color: theme.colors.text.secondary }}
          >
            {line}
          </Text>
        </View>
      </View>
    ) : (
      <Text
        testID={`${testID}.scopeLine`}
        variant="meta"
        style={{ color: theme.colors.text.secondary }}
      >
        {line}
      </Text>
    );
    const defaults = editor.defaults;
    const teamId = read.data?.context.primaryTeamId ?? null;

    return (
      <ItemList testID={testID}>
        <PageHeader
          testID={`${testID}.header`}
          title={t('projects.pages.defaults')}
          description={t('projects.sessionDefaults.description', {
            project: projectName,
          })}
          details={scopeControl}
          detailsPlacement="column"
        />
        {read.status === 'error' || read.status === 'unavailable' ? (
          <ItemGroup>
            <ItemLoadStateRows
              testID={`${testID}.failed`}
              state={{
                kind: 'failed',
                reason: t('projects.sessionDefaults.loadFailed'),
                onRetry: read.refresh,
                homeServerIds: [projectRef.serverId],
              }}
            />
          </ItemGroup>
        ) : !settled ? (
          <ItemGroup>
            <ItemLoadStateRows
              testID={`${testID}.loading`}
              state={{ kind: 'loading' }}
              rows={LOADING_ROWS}
            />
          </ItemGroup>
        ) : (
          <ProjectSessionDefaultsSection
            testID={`${testID}.editor`}
            serverId={projectRef.serverId}
            teamId={teamId}
            defaults={defaults}
            scope={scope === 'me' ? 'personal-project' : 'project'}
            context={read.data?.context}
            source={read.data?.source}
            teamName={read.data?.teamName}
            projectName={projectName}
            editable={editor.access.editable}
            busy={editor.busy}
            save={editor.save}
          />
        )}
      </ItemList>
    );
  },
);
