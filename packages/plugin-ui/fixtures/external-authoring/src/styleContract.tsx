import { Stack } from '@happier-dev/plugin-ui';

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
