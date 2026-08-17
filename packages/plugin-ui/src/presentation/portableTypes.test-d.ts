import type { HappierSpinnerProps } from './feedback/Spinner.js';
import type { HappierSurfaceProps } from './layout/Surface.js';
import type { HappierStyleProp } from './portableTypes.js';
import type { HappierTextProps } from './text/Text.js';

type Assert<Condition extends true> = Condition;

type _PortableStyleDoesNotExposeCoreTextFontVariant = Assert<
  'fontVariant' extends keyof HappierStyleProp ? false : true
>;

type _PortableStyleDoesNotExposeCoreViewTransform = Assert<
  'transform' extends keyof HappierStyleProp ? false : true
>;

const portableText: HappierTextProps = {
  style: {
    // @ts-expect-error `fontVariant` remains an app-private React Native text style.
    fontVariant: ['tabular-nums'],
  },
};

const portableSurface: HappierSurfaceProps = {
  style: {
    // @ts-expect-error `transform` remains an app-private React Native view style.
    transform: [{ scaleX: 0.8 }],
  },
};

const portableSpinner: HappierSpinnerProps = {
  style: {
    // @ts-expect-error `transform` remains an app-private React Native view style.
    transform: [{ scaleX: 0.8 }],
  },
};

void portableText;
void portableSurface;
void portableSpinner;
