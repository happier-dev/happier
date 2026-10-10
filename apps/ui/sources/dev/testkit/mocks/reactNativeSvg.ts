import * as React from 'react';

type SvgHostProps = Record<string, unknown> & { children?: React.ReactNode };

/** Native SVG drawing is the boundary; retain authored props and real renderer logic. */
function host(name: string) {
    const Component = (props: SvgHostProps) => React.createElement(name, props, props.children);
    Component.displayName = name;
    return Component;
}

export const Svg = host('Svg');
export default Svg;
export const SvgXml = host('SvgXml');
export const Circle = host('Circle');
export const Line = host('Line');
export const Path = host('Path');
export const Text = host('SvgText');
export const Defs = host('Defs');
export const G = host('G');
export const Rect = host('Rect');
export const Ellipse = host('Ellipse');
export const Stop = host('Stop');
export const RadialGradient = host('RadialGradient');
export const LinearGradient = host('SvgLinearGradient');
export const ClipPath = host('ClipPath');
export const Mask = host('Mask');
export const Pattern = host('Pattern');
export const Polyline = host('Polyline');
export const Polygon = host('Polygon');
export const TSpan = host('TSpan');
export const Use = host('Use');
export const Image = host('SvgImage');
export const Symbol = host('SvgSymbol');
export const Marker = host('Marker');
export const ForeignObject = host('ForeignObject');
