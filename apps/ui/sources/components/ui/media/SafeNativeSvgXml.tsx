import * as React from 'react';
import { parse, SvgAst, type JsxAST, type SvgProps } from 'react-native-svg';
import { isSafeNativeSvgAst } from './nativeSvgValidation';

export function parseSafeNativeSvgXml(xml: string): JsxAST | null {
    try {
        return parse(xml, root => {
            if (!isSafeNativeSvgAst(root)) throw new Error('Unsafe SVG preview');
            return root;
        });
    } catch {
        return null;
    }
}

export function SafeNativeSvgXml(props: Readonly<{
    xml: string;
    width?: SvgProps['width'];
    height?: SvgProps['height'];
    style?: SvgProps['style'];
    fallback?: React.ReactElement | null;
}>): React.ReactElement | null {
    const ast = React.useMemo(() => parseSafeNativeSvgXml(props.xml), [props.xml]);
    if (!ast) return props.fallback ?? null;
    return <SvgAst ast={ast} override={{ width: props.width, height: props.height, style: props.style }} />;
}
