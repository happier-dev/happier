import * as React from 'react';

// Keep the SDK parser real while the Vite adapter substitutes native drawing tags.
export { parse } from 'react-native-svg/lib/module/xml.js';

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
export const SvgAst = host('SvgAst');
export const Circle = host('Circle');
export const Line = host('Line');
export const Path = host('Path');
export const Text = host('SvgText');
export const TextPath = host('SvgTextPath');
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

// XML parsing and middleware stay real; only the native drawing tags are substituted.
export const tags = {
    svg: Svg, circle: Circle, line: Line, path: Path, text: Text, textPath: TextPath,
    defs: Defs, g: G, rect: Rect, ellipse: Ellipse, stop: Stop,
    radialGradient: RadialGradient, linearGradient: LinearGradient, clipPath: ClipPath,
    mask: Mask, pattern: Pattern, polyline: Polyline, polygon: Polygon,
    tspan: TSpan, use: Use, image: Image, symbol: Symbol, marker: Marker,
    foreignObject: ForeignObject, filter: host('Filter'), feImage: host('FeImage'),
};
