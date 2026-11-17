import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ProjectSessionDefaultsGetOutputV1Schema } from '@happier-dev/protocol/projects/loadManagedSessionDefaultsContextV1';

import { ProjectSessionDefaultsView, type DefaultsScope } from '@/components/projects/sessionDefaults/ProjectSessionDefaultsBody';

/**
 * Lab L11 For me, populated: the project's Team default runs Codex read-only and Claude in safe-yolo; nothing is
 * set For me yet, so each field shows what it falls back to and whose it is.
 */
const POPULATED = ProjectSessionDefaultsGetOutputV1Schema.parse({
  context: { primaryTeamId: 'team-acme', projectDefaults: {
    defaultAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    permissionModeByAgentTargetKey: { 'agent:happier.agent.codex/codex': 'read-only', 'agent:happier.agent.claude/claude': 'safe-yolo' },
  } },
  personalDefaultsRow: null, sourceDefaultsRow: null, source: null, canManageSource: false, repairRequired: false, teamName: 'Acme',
});

/**
 * Dev-only: Project › Session defaults (lab L11) through the real page view: loading and a failed read (states a
 * live Home can't hold still) and a populated For me page from fixture defaults, for either scope. The edited states are judged on the
 * real page with the Team fixture. No Action is issued.
 */
export function SessionDefaultsSpecimen(props: Readonly<{ state: string | null; scope: string | null }>) {
  const [scope, setScope] = React.useState<DefaultsScope>(props.scope === 'project' ? 'project' : 'me');
  const populated = props.state === 'populated';
  const status = populated ? 'ready' as const : props.state === 'failed' ? 'error' as const : 'loading' as const;
  return (
    <View style={styles.root}>
      <View style={styles.frame}>
        <ProjectSessionDefaultsView
          testID="session-defaults-specimen"
          projectName="acme/web"
          serverId="server-specimen"
          hasSource
          scope={scope}
          onScopeChange={setScope}
          status={status}
          data={populated ? POPULATED : null}
          onRetry={async () => {}}
          defaults={{}}
          editable={populated}
          busy={false}
          save={async () => {}}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, alignItems: 'center', backgroundColor: theme.colors.surface.base },
  frame: { flex: 1, width: '100%', maxWidth: 1440 },
}));
