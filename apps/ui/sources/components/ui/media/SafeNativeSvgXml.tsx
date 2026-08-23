import * as React from 'react';
import { SvgAst, type SvgProps } from 'react-native-svg';
import { parse } from 'react-native-svg/lib/commonjs/xml';
import type { JsxAST, XmlAST } from 'react-native-svg/lib/typescript/xml';

const LOCAL_FRAGMENT_PATTERN = /^#[A-Za-z0-9_.:-]+$/;
const SAFE_RASTER_DATA_URI_PATTERN = /^data:image\/(?:png|jpeg|gif|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/i;

function isLocalFragment(value: string): boolean {
    return value === value.trim() && LOCAL_FRAGMENT_PATTERN.test(value);
}

function isSafeRasterDataUri(value: string): boolean {
    if (value !== value.trim()) return false;
    const match = SAFE_RASTER_DATA_URI_PATTERN.exec(value);
    return typeof match?.[1] === 'string' && match[1].length > 0;
}

function containsOnlyLocalCssUrls(value: string): boolean {
    const urlStartPattern = /url\s*\(/gi;
    let match: RegExpExecArray | null;

    while ((match = urlStartPattern.exec(value)) !== null) {
        const targetEnd = value.indexOf(')', urlStartPattern.lastIndex);
        if (targetEnd < 0) return false;

        let target = value.slice(urlStartPattern.lastIndex, targetEnd).trim();
        const quote = target[0];
        if (quote === '"' || quote === '\'') {
            if (target.at(-1) !== quote) return false;
            target = target.slice(1, -1);
        }
        if (!isLocalFragment(target)) return false;

        urlStartPattern.lastIndex = targetEnd + 1;
    }

    return true;
}

function validatePropertyValue(tag: string, propertyName: string, value: unknown): boolean {
    if (/^on/i.test(propertyName)) return false;

    const normalizedPropertyName = propertyName.toLowerCase();
    if (normalizedPropertyName === 'href' || normalizedPropertyName === 'xlinkhref') {
        if (typeof value !== 'string') return false;
        if (isLocalFragment(value)) return true;
        const normalizedTag = tag.toLowerCase();
        return (normalizedTag === 'image' || normalizedTag === 'feimage') && isSafeRasterDataUri(value);
    }

    if (typeof value === 'string') {
        return !/url\s*\(/i.test(value) || containsOnlyLocalCssUrls(value);
    }

    if (value && typeof value === 'object') {
        if (Array.isArray(value)) return false;
        return Object.entries(value as Record<string, unknown>)
            .every(([nestedPropertyName, nestedValue]) => (
                validatePropertyValue(tag, nestedPropertyName, nestedValue)
            ));
    }

    return true;
}

function validateRawSvgAst(node: XmlAST): boolean {
    if (node.tag.toLowerCase() === 'foreignobject') return false;

    const propsAreSafe = Object.entries(node.props as Record<string, unknown>)
        .every(([propertyName, value]) => validatePropertyValue(node.tag, propertyName, value));
    if (!propsAreSafe) return false;

    return node.children.every((child) => (
        typeof child === 'string' || validateRawSvgAst(child)
    ));
}

export function parseSafeNativeSvgXml(xml: string): JsxAST | null {
    try {
        return parse(xml, (root) => {
            if (root.tag !== 'svg' || !validateRawSvgAst(root)) {
                throw new Error('Unsafe SVG preview');
            }
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

    return (
        <SvgAst
            ast={ast}
            override={{
                width: props.width,
                height: props.height,
                style: props.style,
            }}
        />
    );
}
