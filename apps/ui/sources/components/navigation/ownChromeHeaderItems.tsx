import * as React from 'react';

type HeaderItemProps = Readonly<{ tintColor?: string; canGoBack?: boolean }>;
type RenderHeaderItem = (props: HeaderItemProps) => React.ReactNode;
type OwnChromeItem = Readonly<{
  type: 'custom';
  element: React.ReactElement;
  hidesSharedBackground: true;
}>;

const ownChromeItems =
  (render: RenderHeaderItem) =>
  (props: HeaderItemProps): OwnChromeItem[] => [
    {
      type: 'custom',
      element: <>{render(props)}</>,
      hidesSharedBackground: true,
    },
  ];

/**
 * A header control that draws its own Happier chrome (a filled button, a picker chip, the app's Back). iOS 26 backs a
 * bar's custom items with a shared glass capsule; under our own chrome that is a second border (owner, 2026-11-10:
 * Artifacts Save, the PRs & Issues Machine picker). On iOS the item hides that backing; every other header renders
 * `headerRight` as before. One control, one chrome.
 */
export function ownChromeHeaderRight(render: RenderHeaderItem) {
  return {
    headerRight: render,
    unstable_headerRightItems: ownChromeItems(render),
  };
}

/** The leading counterpart of `ownChromeHeaderRight`. */
export function ownChromeHeaderLeft(render: RenderHeaderItem) {
  return {
    headerLeft: render,
    unstable_headerLeftItems: ownChromeItems(render),
  };
}

/** Clears what `ownChromeHeaderRight` published. */
export const CLEARED_HEADER_RIGHT = Object.freeze({
  headerRight: undefined,
  unstable_headerRightItems: undefined,
});
