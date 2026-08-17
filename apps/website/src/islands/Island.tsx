import type { ComponentType } from 'react';

import { ISLAND_ATTR, ISLAND_PROPS_ATTR, serialiseIslandProps, type IslandProps } from './props';

/**
 * The server half of an island: it renders the component exactly as before, and
 * leaves a container in the HTML that the browser can find again.
 *
 * WHY A WRAPPER ELEMENT AND NOT AN ATTRIBUTE ON THE COMPONENT'S OWN ROOT.
 * `hydrateRoot(container, tree)` treats `container` as the PARENT of what React
 * rendered. Marking the component's own root element would give the mounter a
 * container whose contents are the component's children rather than the
 * component, and hydration would try to match `<Nav>` against the inside of
 * `<header>`. The wrapper is the only element on the page that is not part of
 * anybody's design, which is exactly what makes it safe to hand to React.
 *
 * `display: contents` is what keeps that wrapper free. A plain `<div>` inserted
 * between a flex container and its item makes the item stop being a flex item,
 * which silently reflows any island that lives inside a flex or grid parent —
 * the nav row, the badge row, the feature grid. `display: contents` removes the
 * box from layout entirely and leaves the children where they were. It is
 * written inline rather than as a class in src/styles/globals.css so an island
 * is self-contained: the marker and the rule that makes it harmless ship
 * together and cannot be separated by a stylesheet edit.
 *
 * The component is rendered from the SAME `props` object that gets serialised,
 * not from a second copy written by the caller. That is deliberate: the one
 * mistake this API must make impossible is markup rendered from one set of
 * values and hydrated from another, which produces a page that flickers into a
 * different state a second after it loads and no error anywhere.
 *
 * Usage, at the point in the page where the interactive thing sits:
 *
 *     <Island name="nav" component={Nav} props={{ variant: 'static', isHome: false }} />
 *
 * and in that page's client entry:
 *
 *     mountIslands('en', { nav: Nav });
 *
 * The string is the contract between the two. It is the only untyped link in
 * the chain, which is why `mountIslands` fails loudly on a name it was not given
 * a component for rather than skipping it.
 */
export function Island<P extends IslandProps>({
    name,
    component: Component,
    props,
}: {
    /** Matches the key in the page entry's island map. */
    name: string;
    component: ComponentType<P>;
    props?: P;
}) {
    const attrs = {
        [ISLAND_ATTR]: name,
        [ISLAND_PROPS_ATTR]: serialiseIslandProps(name, props),
    };

    return (
        <div {...attrs} style={{ display: 'contents' }}>
            <Component {...((props ?? {}) as P)} />
        </div>
    );
}
