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

export type DefaultsScope = 'me' | 'project';

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
    return (
      <ProjectSessionDefaultsView
        testID={testID}
        projectName={projectName}
        serverId={projectRef.serverId}
        hasSource={sourceRef !== undefined}
        scope={scope}
        onScopeChange={setScope}
        status={read.status}
        data={read.data}
        onRetry={read.refresh}
        defaults={editor.defaults}
        editable={editor.access.editable}
        busy={editor.busy}
        save={editor.save}
      />
    );
  },
);

type SessionDefaultsRead = ReturnType<typeof useProjectSessionDefaults>;
type SessionDefaultsEditor = ReturnType<typeof useProjectSessionDefaultsEditor>;

/** What the page shows for one read and editor state; the specimen mounts it with fixture states. */
export const ProjectSessionDefaultsView = React.memo(function ProjectSessionDefaultsView(
  props: Readonly<{
    testID: string;
    projectName: string;
    serverId: string;
    /** Opened from a shared source: the page offers the shared scope. */
    hasSource: boolean;
    scope: DefaultsScope;
    onScopeChange: (scope: DefaultsScope) => void;
    status: SessionDefaultsRead['status'];
    data: SessionDefaultsRead['data'];
    onRetry: SessionDefaultsRead['refresh'];
    defaults: SessionDefaultsEditor['defaults'];
    editable: boolean;
    busy: boolean;
    save: SessionDefaultsEditor['save'];
  }>,
) {
  const { theme } = useUnistyles();
  const { testID, projectName, scope } = props;
  const setScope = props.onScopeChange;
    const teamName = props.data?.teamName ?? null;
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
    const settled = props.status === 'ready' || props.status === 'refreshing';
    const readOnly = scope === 'project' && settled && !props.editable;
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

    const scopeControl = props.hasSource ? (
      <View style={{ gap: theme.space.s8, alignItems: 'flex-start' }}>
        <SegmentedTabBar
          tabs={tabs}
          activeTabId={scope}
          onSelectTab={setScope}
          // Two scopes hug their names (lab L11), so a long Team name never stretches "For me".
          segmentSizing="content"
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
    const defaults = props.defaults;
    const teamId = props.data?.context.primaryTeamId ?? null;

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
        {props.status === 'error' || props.status === 'unavailable' ? (
          <ItemGroup>
            <ItemLoadStateRows
              testID={`${testID}.failed`}
              state={{
                kind: 'failed',
                reason: t('projects.sessionDefaults.loadFailed'),
                onRetry: props.onRetry,
                homeServerIds: [props.serverId],
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
            serverId={props.serverId}
            teamId={teamId}
            defaults={defaults}
            scope={scope === 'me' ? 'personal-project' : 'project'}
            context={props.data?.context}
            source={props.data?.source}
            teamName={props.data?.teamName}
            projectName={projectName}
            editable={props.editable}
            busy={props.busy}
            save={props.save}
          />
        )}
      </ItemList>
    );
});
