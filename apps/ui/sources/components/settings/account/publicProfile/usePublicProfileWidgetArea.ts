import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { compileWidgetAreaPublicProfileLayoutV1, flattenWidgetLayoutWidgetsV1,
  WidgetDefinitionActionOutputSchemasV1, type BuiltinUsagePublicPresentationV1, type PublicProfileLayoutV1,
  type WidgetAreaLayoutV1 } from '@happier-dev/protocol/widgets';
import { createPublicProfileWidgetAreaPresetsV1, type PublicProfileLayoutPresetIdV1 } from '@happier-dev/protocol/widgets/publicProfileWidgetPresetsV1';

import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAppShellPluginUiDeclarationSources } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useCorePageWidgetAreaBinding } from '@/components/widgets/area/useCorePageWidgetAreaBinding';
import { useWidgetAreaLayout, type WidgetAreaLayout, type WidgetAreaPort } from '@/components/widgets/area/useWidgetAreaLayout';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { readWidgetDescriptor } from '@/components/widgets/widgetCatalog';
import { storage } from '@/sync/domains/state/storage';

const EMPTY_CONTEXT: WidgetSurfaceContext = Object.freeze({});
const UNAVAILABLE_PORT: WidgetAreaPort = { execute: async () => ({ ok: false,
  errorCode: 'widget_area_scope_retired', error: 'widget_area_scope_retired' }) };

export type PublicProfileWidgetArea = Readonly<{
  binding: ReturnType<typeof useCorePageWidgetAreaBinding>;
  area: WidgetAreaLayout<WidgetSurfaceContext>;
  candidate: Readonly<{ layout: PublicProfileLayoutV1; selection: WidgetAreaLayoutV1 }> | null;
  status: 'ready' | 'unavailable' | 'loading';
}>;

/** Private placement remains an Account Artifact; this is only its inert reviewed-copy adapter. */
export function usePublicProfileWidgetArea(serverId: string,
  execution: Pick<ReturnType<typeof useMountedActionExecution>, 'executeValue' | 'getSignal'>,
  title?: (presentation: BuiltinUsagePublicPresentationV1) => string | undefined,
  /** The page's own context (its public period), so placed widgets read what the page covers. */
  context: WidgetSurfaceContext = EMPTY_CONTEXT,
  names?: Readonly<Record<PublicProfileLayoutPresetIdV1, string>>): PublicProfileWidgetArea {
  const presets = React.useMemo(() => createPublicProfileWidgetAreaPresetsV1({ title, ...(names ? { names } : {}) }), [title, names]);
  const binding = useCorePageWidgetAreaBinding({ serverId, pageId: 'public-profile', area: 'main', presets, context });
  const area = useWidgetAreaLayout(binding.port ?? UNAVAILABLE_PORT, context);
  const declarations = useAppShellPluginUiDeclarationSources();
  const state = area.state;
  const artifactIds = React.useMemo(() => state.status === 'ready'
    ? [...new Set(flattenWidgetLayoutWidgetsV1(state.items).flatMap(item => item.instance.definition.kind === 'artifact'
      ? [item.instance.definition.artifactId] : []))] : [], [state.status === 'ready' ? state.items : null]);
  // Definition edits invalidate only copies using those definitions, never every Account Artifact.
  const artifacts = storage(useShallow(store => artifactIds.map(id => store.artifacts[id] ?? null)));
  const selection = React.useMemo<WidgetAreaLayoutV1 | null>(() => state.status === 'ready'
    ? { v: 1, surface: state.surface, items: state.items } : null,
  [state.status === 'ready' ? state.surface : null, state.status === 'ready' ? state.items : null]);
  // A failed reread changes the area's notice, not its already-admitted layout or compiled preview.
  const source = React.useMemo(() => ({ selection, surface: binding.surface, context, declarations, artifacts }),
    [selection, binding.surface, context, declarations, artifacts]);
  const execute = React.useRef(execution);
  execute.current = execution;
  const [compiled, setCompiled] = React.useState<Readonly<{ source: typeof source;
    candidate: NonNullable<PublicProfileWidgetArea['candidate']> }> | null>(null);
  const [failure, setFailure] = React.useState<typeof source | null>(null);

  React.useEffect(() => {
    const { selection, surface, declarations } = source;
    if (!selection || !surface) return;
    let active = true;
    const controller = new AbortController();
    const accountSignal = execute.current.getSignal();
    const abort = () => controller.abort();
    if (accountSignal.aborted) return;
    accountSignal.addEventListener('abort', abort, { once: true });
    // This copy serves the local Preview. Publication sends the captured selection to Action preparation.
    void compileWidgetAreaPublicProfileLayoutV1(selection, {
      resolveDefinition: async reference => {
        const result = await execute.current.executeValue('widgets.definition.get', {
          account: { serverId: selection.surface.serverId, accountId: selection.surface.accountId }, artifactId: reference.artifactId,
        }, { signal: controller.signal });
        return WidgetDefinitionActionOutputSchemasV1['widgets.definition.get'].parse(result).definition;
      },
      resolveInstalledView: surface => readWidgetDescriptor(declarations.projection, surface),
    }).then(layout => {
      if (active && !controller.signal.aborted) setCompiled({ source, candidate: { layout, selection } });
    }).catch(() => { if (active && !controller.signal.aborted) setFailure(source); });
    return () => { active = false; accountSignal.removeEventListener('abort', abort); controller.abort(); };
  }, [source]);

  const candidate = compiled?.source === source ? compiled.candidate : null;
  const unavailable = state.status === 'unavailable' || state.status === 'ready' && Boolean(state.readFailure) || failure === source;
  return { binding, area, candidate, status: unavailable ? 'unavailable' as const : candidate ? 'ready' as const : 'loading' as const };
}
