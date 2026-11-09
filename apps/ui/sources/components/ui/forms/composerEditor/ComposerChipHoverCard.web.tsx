import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { parseMentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { INLINE_REFERENCE_ATTACHMENT_SCHEME_V1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';

import { Icon } from '@/components/ui/icons/Icon';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import type { HoverPreviewHandlers } from '@/components/ui/popover/useHoverPreviewPopover';
import { resolveReferenceChipIconName } from '@/components/ui/referenceChip/referenceChipIcon';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { ComposerEditorReference } from './composerEditorTypes';

const HOVER_CARD_WIDTH_PX = 300;

export type ComposerChipHoverTarget = Readonly<{
  element: HTMLElement;
  reference: ComposerEditorReference;
  open?: () => void;
  remove: () => void;
}>;

/** What the chip stands for, in one quiet line under its name. */
function describeReference(reference: ComposerEditorReference): string | null {
  if (reference.state === 'removed')
    return t('composerReferences.removedDetail');
  if (reference.state === 'unavailable')
    return t('composerReferences.unavailableDetail');
  const parsed = parseMentionRefV1(reference.ref);
  switch (parsed?.scheme) {
    case 'file':
      return parsed.opaque.endsWith('/')
        ? `${t('composerReferences.kindFolder')} · ${parsed.opaque}`
        : parsed.opaque;
    case 'session':
      return t('composerReferences.kindSession');
    case 'skill':
      return t('composerReferences.kindSkill');
    case 'vendorPlugin':
      return t('composerReferences.kindPlugin');
    case 'workflow':
      return t('composerReferences.kindWorkflow');
    case 'widget':
      return t('composerReferences.kindWidget');
    case INLINE_REFERENCE_ATTACHMENT_SCHEME_V1:
      return reference.accessibilityLabel &&
        reference.accessibilityLabel !== reference.label
        ? reference.accessibilityLabel
        : null;
    default:
      return null;
  }
}

/**
 * A chip's identity on hover (web; lab CA hover): its full name, what it is, and the two things a
 * person does with a chip — open what it points at, or take it out of the message (its tray item
 * stays). Drawn in the input's own tree, anchored to the hovered chip, as a floating surface.
 */
export function ComposerChipHoverCard(
  props: Readonly<{
    target: ComposerChipHoverTarget;
    panelHoverProps: HoverPreviewHandlers | null;
    onRequestClose: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const anchorRef = React.useRef<HTMLElement | null>(props.target.element);
  anchorRef.current = props.target.element;
  const { reference } = props.target;
  const detail = describeReference(reference);
  const icon = resolveReferenceChipIconName({ ref: reference.ref });
  const open = reference.state === 'removed' ? undefined : props.target.open;
  return (
    <Popover
      open
      anchor={{ kind: 'view', ref: anchorRef }}
      // A chip's card answers the resting pointer: it stacks under every popover or menu someone opened.
      layer="hoverCard"
      backdrop={false}
      boundaryRef={null}
      placement="top"
      flip
      gap={6}
      edgePadding={8}
      portal={{
        web: true,
        matchAnchorWidth: false,
        anchorAlign: 'start',
        sizeToContent: true,
      }}
      maxWidthCap={HOVER_CARD_WIDTH_PX}
      minWidth={0}
      onRequestClose={props.onRequestClose}
    >
      {() => (
        <View testID="composer-chip-hover-card" {...props.panelHoverProps}>
          <FloatingOverlay
            surfaceChrome="theme"
            scrollEnabled={false}
            containerStyle={styles.card}
          >
            <View style={styles.body}>
              <View style={styles.identity}>
                {icon ? <Icon name={icon} size={15} color={theme.colors.text.primary} /> : null}
                <Text
                  variant="label"
                  emphasis="semiBold"
                  numberOfLines={2}
                  style={styles.name}
                >
                  {reference.label}
                </Text>
              </View>
              {detail ? (
                <Text variant="meta" numberOfLines={2} style={styles.detail}>
                  {detail}
                </Text>
              ) : null}
              <View style={styles.actions}>
                {open ? (
                  <TextLinkButton
                    size="meta"
                    label={t('composerReferences.open')}
                    onPress={open}
                  />
                ) : null}
                <TextLinkButton
                  size="meta"
                  label={t('composerReferences.removeFromMessage')}
                  onPress={props.target.remove}
                />
              </View>
            </View>
          </FloatingOverlay>
        </View>
      )}
    </Popover>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: { width: HOVER_CARD_WIDTH_PX },
  body: {
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
  },
  identity: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  name: { flexShrink: 1, color: theme.colors.text.primary },
  detail: { color: theme.colors.text.secondary, marginTop: 2 },
  actions: {
    flexDirection: 'row',
    gap: theme.space.s12,
    marginTop: theme.space.s8,
    paddingTop: theme.space.s8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
}));
