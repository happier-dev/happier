import * as React from 'react';
import { View } from 'react-native';
import type {
  WidgetInstanceV1,
  WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';

import { useAppShellPluginUiProjectionCurrentness } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { WidgetSurface } from '@/components/widgets/surface/WidgetSurface';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';

const EMPTY_CONTEXT = Object.freeze({});

/**
 * A saved widget, read: the widget itself, mounted by the one widget surface owner with the
 * viewer's own access (as it would read on their Home), never its stored definition as text.
 */
export function ArtifactWidgetBody(
  props: Readonly<{ artifactId: string; bodyVersion: number | undefined }>,
): React.ReactElement {
  const runtime = useAppShellPluginUiProjectionCurrentness();
  const accountScope = useActiveServerAccountScope();
  const scope = React.useMemo<WidgetSurfaceRefV1 | null>(
    () => (accountScope ? { ...accountScope, owner: { kind: 'home' } } : null),
    [accountScope],
  );
  const instance = React.useMemo<WidgetInstanceV1>(
    () => ({
      v: 1,
      id: `artifact-view:${props.artifactId}`,
      definition: { kind: 'artifact', artifactId: props.artifactId },
      bindings: {},
    }),
    [props.artifactId],
  );
  return (
    <View testID="artifact:widget">
      {scope ? (
        <WidgetSurface
          scope={scope}
          instance={instance}
          descriptor={null}
          providedContext={EMPTY_CONTEXT}
          recordRevision={`${props.artifactId}:${props.bodyVersion ?? 0}`}
          presentation="content"
          appRuntime={runtime}
          testID="artifact:widget-surface"
        />
      ) : null}
    </View>
  );
}
