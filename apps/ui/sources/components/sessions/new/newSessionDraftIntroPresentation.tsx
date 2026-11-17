import * as React from 'react';

/**
 * A seeded draft's first screen in the dock: stacked first in the card's own top content, the seat the dock's frost
 * rises from (`composerTopContentRef`), so the intro stands inside the frosted surface at every width and never draws
 * over the page. A draft without an intro keeps the very same props.
 */
export function withDraftIntroPresentation<Props extends Readonly<{ composerTopContent?: React.ReactNode }>>(
    panelProps: Props,
    intro: React.ReactNode | null | undefined,
): Props {
    if (intro === null || intro === undefined) return panelProps;
    return { ...panelProps, composerTopContent: <>{intro}{panelProps.composerTopContent ?? null}</> };
}
