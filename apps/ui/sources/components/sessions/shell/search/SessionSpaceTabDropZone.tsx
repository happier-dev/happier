import * as React from 'react';
import { View } from 'react-native';
import type {
  EntityDropAdmissionV1,
  EntityDropEffectV1,
  EntityDropOutcomeV1,
} from '@happier-dev/protocol/plugins/ui';
import {
  useEntityDragDropRuntime,
  useEntityDropTarget,
  useEntityDropTargetState,
  measureWindowBounds,
  readWindowBounds,
  TreeDropOutline,
  useEntityDropDomBinding,
  type EntityDropResolveContext,
  type WindowBounds,
} from '@/components/ui/treeDragDrop';

/** The Session list owner's Add to space, reached from a space tab: its admission and its mounted Action. */
export type SessionSpaceDrop = Readonly<{
  resolve: (
    context: EntityDropResolveContext,
    spaceId: string,
  ) => EntityDropAdmissionV1;
  execute: (
    effect: EntityDropEffectV1,
    context: EntityDropResolveContext,
  ) => Promise<EntityDropOutcomeV1>;
}>;

const OUTLINE_STYLE = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  pointerEvents: 'none',
} as const;

/** This leaf alone subscribes to the carry; pointer frames never rerender the strip. */
function SessionSpaceTabTarget(
  props: Readonly<{
    spaceId: string;
    spaceDrop: () => SessionSpaceDrop | null;
    targetId: string;
    testID: string;
    bounds: () => WindowBounds | null;
    measure: () => Promise<void>;
  }>,
): React.ReactElement | null {
  const runtime = useEntityDragDropRuntime();
  useEntityDropTarget(runtime, {
    id: props.targetId,
    scopeMode: 'source',
    acceptedKinds: ['session'],
    captureKinds: ['session'],
    getBounds: props.bounds,
    measureBounds: props.measure,
    resolve: (context) =>
      props.spaceDrop()?.resolve(context, props.spaceId) ?? {
        status: 'refused',
        reason: { code: 'unavailable', message: 'unavailable' },
      },
    execute: async (effect, context) =>
      props.spaceDrop()?.execute(effect, context) ?? {
        status: 'refused',
        reason: { code: 'unavailable', message: 'unavailable' },
      },
  });
  const snapshot = useEntityDropTargetState(runtime, props.targetId);
  // Outcome and refusal copy is the realm's preview; the tab only draws the standard admitted outline.
  return snapshot?.admission?.status === 'allowed' &&
    snapshot.phase === 'carrying' ? (
    <TreeDropOutline
      testID={`${props.testID}-drop`}
      visual={{ kind: 'outline', targetId: props.targetId }}
      style={OUTLINE_STYLE}
    />
  ) : null;
}

/**
 * A space tab in the Sessions strip as a drop target (owner 11-08): a carried Session dropped on it is added to that
 * space through the list owner's Add to space. The space it is already in is a quiet no-change.
 */
export function SessionSpaceTabDropZone(
  props: Readonly<{
    spaceId: string;
    spaceDrop: () => SessionSpaceDrop | null;
    testID: string;
    children: React.ReactNode;
  }>,
): React.ReactElement {
  const runtime = useEntityDragDropRuntime();
  const targetId = React.useId();
  const host = React.useRef<View | null>(null);
  const nativeBounds = React.useRef<WindowBounds | null>(null);
  const dropRef = useEntityDropDomBinding(runtime, {
    captureKinds: ['session'],
  });
  const attach = React.useCallback(
    (node: View | null) => {
      host.current = node;
      dropRef(node);
    },
    [dropRef],
  );
  const bounds = React.useCallback(
    () => readWindowBounds(host.current) ?? nativeBounds.current,
    [],
  );
  const measure = React.useCallback(async () => {
    const node = host.current;
    const next = await measureWindowBounds(node);
    if (host.current === node) nativeBounds.current = next;
  }, []);
  const onLayout = React.useCallback(() => {
    void measure().then(() => runtime.refresh());
  }, [measure, runtime]);
  return (
    <View
      ref={attach}
      collapsable={false}
      testID={props.testID}
      onLayout={onLayout}
    >
      {props.children}
      <SessionSpaceTabTarget
        spaceId={props.spaceId}
        spaceDrop={props.spaceDrop}
        targetId={targetId}
        testID={props.testID}
        bounds={bounds}
        measure={measure}
      />
    </View>
  );
}
