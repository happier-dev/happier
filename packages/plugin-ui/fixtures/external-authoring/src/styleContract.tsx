import { Stack } from '@happier-dev/plugin-ui';
import type { InboxItemAttentionTypeV1, PluginUiIconTokenV1 } from '@happier-dev/plugin-sdk/ui';
import type { CollectionGroupRollup, HappierWorkStatusPresentation } from '@happier-dev/plugin-ui/components';

// External authors use the same public status family and canonical SDK constituents.
const externalAttentionType: InboxItemAttentionTypeV1 | null = null;
const externalStatusGlyph: PluginUiIconTokenV1 = 'review';
const externalWorkStatus = {
  state: 'reviewing', bucket: 'working', tone: 'neutral', attentionType: externalAttentionType,
  word: 'Reviewing', glyph: externalStatusGlyph,
} satisfies HappierWorkStatusPresentation;
const externalGroupRollup = {
  status: externalWorkStatus, needsYouCount: null, coverage: 'partial',
} satisfies CollectionGroupRollup;
void externalGroupRollup;

const supportedPortableStyle = (
  <Stack
    style={[
      { color: '#ffffff', fontSize: 14, lineHeight: 20, letterSpacing: 0.2 },
      false,
      { textAlign: 'center' },
    ]}
  >Portable</Stack>
);

// @ts-expect-error String/CSS shorthand is not a portable RN/RNW style.
const primitiveStyleMustFail = <Stack style="font-size: 14px">Invalid</Stack>;

const unsupportedPropertyMustFail = (
  // @ts-expect-error CSS grid is outside the curated RN/RNW presentation contract.
  <Stack style={{ gridTemplateColumns: '1fr' }}>Invalid</Stack>
);

void supportedPortableStyle;
void primitiveStyleMustFail;
void unsupportedPropertyMustFail;
