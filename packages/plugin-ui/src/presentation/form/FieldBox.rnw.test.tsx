import { Text, TextInput } from 'react-native';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierMaterialRoleProvider } from '../layout/Surface.js';
import { HappierFieldBoxTrigger, HappierFieldTextBox } from './FieldBox.js';

/**
 * WF-ACCEPT-1119B item 6: on a popover (the floating glass plane) the field box took the plane's translucent coat, so
 * Allowed tools, Time limit and Saves-as read grey-filled at 1440 while the same fields were white on the page and in
 * the 390 sheet (lab bstep-v-Aopen, pop-v: white outlined fields). A field is a control: it keeps its own fill on every
 * plane. The plane's colour resolver is the boundary here; a sentinel shows whether the box asked it for a coat.
 */
const COAT = 'rgb(1, 2, 3)';
const FIELD = {
  borderColor: 'rgb(200, 200, 200)',
  backgroundColor: 'rgb(255, 255, 255)',
  edge: null,
  focusRing: null,
} as const;

function paintedBackgrounds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('*')).map(
    (node) => getComputedStyle(node).backgroundColor,
  );
}

describe('field box on a floating plane', () => {
  it.each(['text box', 'select trigger'] as const)(
    'keeps its own fill on a popover (%s)',
    (kind) => {
      const field =
        kind === 'text box' ? (
          <HappierFieldTextBox colors={FIELD}>
            <TextInput accessibilityLabel="Allowed tools" />
          </HappierFieldTextBox>
        ) : (
          <HappierFieldBoxTrigger colors={FIELD}>
            <Text>Ask first</Text>
          </HappierFieldBoxTrigger>
        );
      const view = mountThroughReactNativeWeb(
        <HappierMaterialRoleProvider
          role="floating"
          resolveMaterialColor={() => COAT}
        >
          {field}
        </HappierMaterialRoleProvider>,
      );
      try {
        const painted = paintedBackgrounds(view.container);
        expect(painted).not.toContain(COAT);
        expect(painted).toContain(FIELD.backgroundColor);
      } finally {
        view.unmount();
      }
    },
  );
});
