import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  HAPPIER_CARRIED_SOURCE_OPACITY,
  HAPPIER_WIDGET_FRAME_METRICS,
} from '@happier-dev/plugin-ui/presentation';
import type {
  EntityDragItemV1,
  EntityDropAdmissionV1,
} from '@happier-dev/protocol/plugins/ui';
import type {
  WidgetLayoutGroupV1,
  WidgetLayoutItemV1,
  WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';

import { SplitCanvasDropOverlay } from '@/components/appShell/splitCanvas/components/SplitCanvasDropOverlay';
import { Text } from '@/components/ui/text/Text';
import { describeEntityDropOutcome } from '@/components/ui/treeDragDrop/ui/entityDropOutcome';
import { EntityReleasePreviewCard } from '@/components/ui/treeDragDrop/ui/EntityReleasePreview';
import { TreeDropIndicatorLine } from '@/components/ui/treeDragDrop/ui/TreeDropIndicatorLine';
import { TreeDropOutline } from '@/components/ui/treeDragDrop/ui/TreeDropOutline';
import { resolveWidgetLayoutEntityDrop } from '@/components/ui/treeDragDrop/widgetLayoutEntityDrop';
import { widgetMovementRefused } from '@/sync/ops/actions/widgetEntityMovement';

import { CHANGES, GroupSpecimen, SERVICES } from './groupSpecimens';
import type { WidgetSpecimenFrames } from './widgetSpecimenTypes';

/**
 * Widget drag and drop at static props (lab `widget-groups` wgdnd, lab `drag-drop` ddcenter C2): the
 * real group frame under the real outline and insertion line, and the real release preview card
 * saying what the real layout resolver and refusal presenter say. No carry runs here.
 */

const scope = { serverId: 'specimen', accountId: 'specimen' };
const surface: WidgetSurfaceRefV1 = { ...scope, owner: { kind: 'home' } };
const widget = (
  id: string,
  size: 'small' | 'full' = 'small',
): WidgetLayoutItemV1 => ({
  kind: 'widget',
  size,
  instance: {
    v: 1,
    id,
    definition: { kind: 'builtin', id: 'changes' },
    bindings: {},
  },
});
const HAPPIER: WidgetLayoutGroupV1 = {
  kind: 'group',
  id: 'happier',
  title: 'happier',
  width: 'full',
  frameStyle: 'card',
  dividers: 'hairline',
  children: [
    widget('changes'),
    widget('services'),
  ] as WidgetLayoutGroupV1['children'],
};
const WEBSITE: WidgetLayoutGroupV1 = {
  ...HAPPIER,
  id: 'website',
  title: 'website',
  width: 'half',
};
const ITEMS: readonly WidgetLayoutItemV1[] = [
  HAPPIER,
  WEBSITE,
  widget('signups'),
  widget('daily', 'full'),
];
const carried = (sectionId: string): EntityDragItemV1 => ({
  kind: 'home-section',
  scope,
  sectionId,
});

/** What the shared owner says for a carry, through the one refusal presenter every host uses. */
function admit(
  item: EntityDragItemV1,
  destination: unknown,
  target: string,
): EntityDropAdmissionV1 {
  const admission = resolveWidgetLayoutEntityDrop({
    item,
    surface,
    items: ITEMS,
    canEdit: true,
    destination,
    preview: { verb: 'Organize', target },
  });
  return admission.status === 'refused'
    ? widgetMovementRefused(admission.reason.code, admission.preview)
    : admission;
}

function Preview(
  props: Readonly<{
    title: string;
    subtitle: string;
    admission: EntityDropAdmissionV1;
    testID: string;
  }>,
) {
  return (
    <View style={stylesheet.preview}>
      <EntityReleasePreviewCard
        identity={{ title: props.title, subtitle: props.subtitle }}
        outcome={describeEntityDropOutcome(
          { phase: 'carrying', admission: props.admission },
          props.title,
        )}
        testID={props.testID}
      />
    </View>
  );
}

const FILL = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

export const DND_SPECIMEN_FRAMES: WidgetSpecimenFrames = {
  /** wgdnd 1: into a group — the group outlines, the line sits on the hairline, the preview names group and place. */
  WGDND_INTO: ({ phone }) => (
    <View style={stylesheet.stack}>
      <View>
        <GroupSpecimen
          id="happier"
          phone={phone}
          items={[CHANGES, SERVICES]}
          options={{ title: 'happier' }}
        />
        <View pointerEvents="none" style={FILL}>
          <TreeDropOutline
            weight="container"
            radius={HAPPIER_WIDGET_FRAME_METRICS.cardRadiusPx}
            visual={{ kind: 'outline', targetId: 'happier' }}
            style={FILL}
            testID="dnd.into.outline"
          />
        </View>
      </View>
      <TreeDropIndicatorLine
        visual={{ kind: 'line', targetId: 'changes', edge: 'bottom', depth: 0 }}
        indentPx={0}
        testID="dnd.into.line"
      />
      <Preview
        testID="dnd.into.preview"
        title="Signups this week"
        subtitle="analytics replica · Small"
        admission={admit(
          carried('signups'),
          { groupId: 'happier', anchorId: 'changes', placement: 'after' },
          'Changes',
        )}
      />
    </View>
  ),
  /** wgdnd 2-4: out of a group (its cell stays, dimmed), reorder inside, a whole group. */
  WGDND_MOVES: ({ phone }) => (
    <View style={stylesheet.stack}>
      <View style={{ opacity: HAPPIER_CARRIED_SOURCE_OPACITY }}>
        <GroupSpecimen
          id="carried"
          phone={phone}
          items={[CHANGES]}
          options={{ title: 'happier' }}
        />
      </View>
      <Preview
        testID="dnd.out.preview"
        title="Changes"
        subtitle="happier · Small"
        admission={admit(
          carried('changes'),
          { groupId: null, anchorId: 'signups', placement: 'before' },
          'Signups this week',
        )}
      />
      <Preview
        testID="dnd.inside.preview"
        title="Changes"
        subtitle="happier · Small"
        admission={admit(
          carried('changes'),
          { groupId: 'happier', anchorId: 'services', placement: 'after' },
          'Local services',
        )}
      />
      <Preview
        testID="dnd.whole.preview"
        title="website"
        subtitle="Group · 2 widgets"
        admission={admit(
          {
            kind: 'widget-layout-group',
            scope,
            ref: { surface, instanceId: 'website' },
          },
          { groupId: null, anchorId: 'signups', placement: 'after' },
          'Signups this week',
        )}
      />
    </View>
  ),
  /** wgdnd 5, 6 and the other refusals: nothing lights; the preview gives the reason and the way forward. */
  WGDND_REFUSED: () => (
    <View style={stylesheet.stack}>
      <Preview
        testID="dnd.refused.width"
        title="Daily usage"
        subtitle="tokens by agent · Wide"
        admission={admit(
          carried('daily'),
          { groupId: 'website', anchorId: null, placement: 'after' },
          'website',
        )}
      />
      <Preview
        testID="dnd.refused.nesting"
        title="website"
        subtitle="Group · 2 widgets"
        admission={admit(
          {
            kind: 'widget-layout-group',
            scope,
            ref: { surface, instanceId: 'website' },
          },
          { groupId: 'happier', anchorId: null, placement: 'after' },
          'happier',
        )}
      />
      {(
        [
          'widget_edit_denied',
          'unsupported_widget_transfer',
          'widget_instance_already_exists',
          'widget_inputs_unavailable',
          'widget_instance_changed',
          'scope-mismatch',
          'a_future_owner_code',
        ] as const
      ).map((code) => (
        <Preview
          key={code}
          testID={`dnd.refused.${code}`}
          title="Signups this week"
          subtitle="analytics replica · Small"
          admission={widgetMovementRefused(code, {
            verb: 'Move to Project',
            target: 'Project',
          })}
        />
      ))}
      {/* Over its own place, and while admission is still being read: only what is carried. */}
      <Preview
        testID="dnd.silent.same"
        title="Signups this week"
        subtitle="analytics replica · Small"
        admission={widgetMovementRefused('same-position', {
          verb: 'Organize',
          target: 'Home',
        })}
      />
      <Preview
        testID="dnd.silent.pending"
        title="Signups this week"
        subtitle="analytics replica · Small"
        admission={widgetMovementRefused('widget_admission_pending', {
          verb: 'Organize',
          target: 'Home',
        })}
      />
    </View>
  ),
  /** ddcenter C2: the centre takes the whole pane's soft outline; its content stays readable. */
  DDCENTER: () => (
    <View style={stylesheet.pane}>
      <Text style={stylesheet.paneText}>
        Review #2481 and fix what the reviewer flagged.
      </Text>
      <Text style={stylesheet.paneText}>
        The reviewer flagged two things: the collection grid drops its selection
        on resize, and the empty state has no action. Both are fixed.
      </Text>
      <SplitCanvasDropOverlay
        target={{ leafId: 'specimen', placement: 'center' }}
        edgeMarks={['left', 'right', 'up', 'down']}
      />
    </View>
  ),
  /** C2s: the edge keeps the frosted band. */
  DDEDGE: () => (
    <View style={stylesheet.pane}>
      <Text style={stylesheet.paneText}>
        Review #2481 and fix what the reviewer flagged.
      </Text>
      <Text style={stylesheet.paneText}>
        The reviewer flagged two things: the collection grid drops its selection
        on resize, and the empty state has no action. Both are fixed.
      </Text>
      <SplitCanvasDropOverlay
        target={{ leafId: 'specimen', placement: 'right' }}
      />
    </View>
  ),
};

const stylesheet = StyleSheet.create((theme) => ({
  stack: { gap: 16 },
  preview: { alignSelf: 'flex-start' },
  pane: {
    height: 360,
    padding: 24,
    gap: 12,
    backgroundColor: theme.colors.surface.base,
  },
  paneText: { color: theme.colors.text.primary },
}));
