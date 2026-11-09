import * as React from 'react';
import type { WidgetInstanceV1 } from '@happier-dev/protocol/widgets';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useSessionPluginRuntime } from '@/components/sessions/plugins/useSessionPluginRuntime';
import {
  readSessionHostWidgetDescriptor,
  readWidgetDescriptor,
  type WidgetCandidate,
} from '@/components/widgets/widgetCatalog';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';

/**
 * The installed-widget descriptor a Session host (Companion, Board) names a copy by. The exact Session's
 * plugin runtime is read only when the app shell does not name the widget, so App widgets add no Session read.
 */
export function useSessionHostWidgetDescriptor(
  params: Readonly<{
    serverId: string | null;
    sessionId: string;
    instance: WidgetInstanceV1 | null;
  }>,
): WidgetCandidate | null {
  const appProjection = useAppShellPluginUiProjection(
    (value) => value.pluginUiProjection,
  );
  const definition = params.instance?.definition ?? null;
  const namedByApp = React.useMemo(
    () =>
      definition
        ? readWidgetDescriptor(appProjection, definition) !== null
        : true,
    [appProjection, definition],
  );
  const address = React.useMemo(
    () =>
      definition?.kind === 'installed' && !namedByApp
        ? normalizeSessionAddress(params.serverId, params.sessionId)
        : null,
    [definition, namedByApp, params.serverId, params.sessionId],
  );
  const sessionProjection = useSessionPluginRuntime({
    address,
  }).pluginUiProjection;
  const localizeApp = usePluginLocalizedTextResolver({
    projection: appProjection,
  });
  const localizeSession = usePluginLocalizedTextResolver({
    projection: sessionProjection,
  });
  const displayName = params.instance?.displayName;
  return React.useMemo(
    () =>
      definition
        ? readSessionHostWidgetDescriptor(
            { app: appProjection, session: address ? sessionProjection : null },
            definition,
            displayName
              ? undefined
              : { app: localizeApp, session: localizeSession },
          )
        : null,
    [
      address,
      appProjection,
      definition,
      displayName,
      localizeApp,
      localizeSession,
      sessionProjection,
    ],
  );
}
