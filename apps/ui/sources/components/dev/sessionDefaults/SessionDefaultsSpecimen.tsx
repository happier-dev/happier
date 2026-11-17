import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ProjectSessionDefaultsView, type DefaultsScope } from '@/components/projects/sessionDefaults/ProjectSessionDefaultsBody';

/**
 * Dev-only: Project › Session defaults (lab L11) in the states a live Home can't hold still — loading
 * and a failed read — through the real page view, for either scope. The edited states are judged on the
 * real page with the Team fixture. No Action is issued.
 */
export function SessionDefaultsSpecimen(props: Readonly<{ state: string | null; scope: string | null }>) {
  const [scope, setScope] = React.useState<DefaultsScope>(props.scope === 'project' ? 'project' : 'me');
  const status = props.state === 'failed' ? 'error' as const : 'loading' as const;
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
          data={null}
          onRetry={() => {}}
          defaults={{}}
          editable={false}
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
