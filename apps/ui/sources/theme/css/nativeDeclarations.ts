import normalizeColor from '@react-native/normalize-colors';

import { FontFamilies } from '@/constants/Typography';

export type NativeDeclarationStyle = Readonly<Record<string, string | number>>;
export type NativeDeclarationConversion = Readonly<
    { supported: true; style: NativeDeclarationStyle } | { supported: false; reason: 'property' | 'value' }
>;
export type NativeDeclarationDescriptor = Readonly<{
    syntax: string;
    partKind?: 'text';
    convert: (value: string) => NativeDeclarationStyle | null;
}>;

type NativeValue = string | number;
type ValueParser = (value: string) => NativeValue | null;

const CSS_NUMBER = '[+-]?(?:\\d*\\.\\d+|\\d+\\.?\\d*)(?:[eE][+-]?\\d+)?';
const numberPattern = new RegExp(`^${CSS_NUMBER}$`, 'u');
const dimensionPattern = new RegExp(`^(${CSS_NUMBER})(px|pt|%)?$`, 'iu');
const sides = ['Top', 'Right', 'Bottom', 'Left'] as const;
const corners = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'] as const;
const bundledFonts = new Set([
    ...Object.values(FontFamilies.default),
    ...Object.values(FontFamilies.mono),
    ...Object.values(FontFamilies.logo),
    FontFamilies.legacy.spaceMono,
]);

function parseNumber(value: string): number | null {
    if (!numberPattern.test(value)) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeNumber(value: string): number | null {
    const number = parseNumber(value);
    return number !== null && number >= 0 ? number : null;
}

function dimension(options: Readonly<{ negative?: boolean; percent?: boolean; auto?: boolean }> = {}): ValueParser {
    return value => {
        if (options.auto && value.toLowerCase() === 'auto') return 'auto';
        const match = dimensionPattern.exec(value);
        if (!match) return null;
        const number = Number(match[1]);
        if (!Number.isFinite(number) || (!options.negative && number < 0)) return null;
        const unit = match[2]?.toLowerCase();
        if (!unit) return number === 0 ? 0 : null;
        if (unit === '%') return options.percent ? `${number}%` : null;
        return unit === 'pt' ? number * 4 / 3 : number;
    };
}

function literalColor(value: string): string | null {
    const literal = value.toLowerCase();
    // Native function matchers are unanchored: admit a whole literal so var() fallbacks
    // and compound backgrounds cannot accidentally become their embedded RGB colour.
    if (!/^(?:#[0-9a-f]+|[a-z]+|(?:rgba?|hsla?|hwb)\([^()]*\))$/u.test(literal)) return null;
    const normalized = normalizeColor(literal);
    if (normalized === null) return null;
    const red = (normalized >>> 24) & 255;
    const green = (normalized >>> 16) & 255;
    const blue = (normalized >>> 8) & 255;
    const alpha = (normalized & 255) / 255;
    return alpha === 1 ? `rgb(${red}, ${green}, ${blue})` : `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/** Split shorthand components while keeping functional colours and quoted font names whole. */
function components(value: string): string[] | null {
    const result: string[] = [];
    let start = 0;
    let depth = 0;
    let quote = '';
    for (let i = 0; i < value.length; i++) {
        const character = value[i]!;
        if (character === '\\') return null;
        if (quote) {
            if (character === quote) quote = '';
        } else if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '(') {
            depth++;
        } else if (character === ')') {
            if (--depth < 0) return null;
        } else if (/\s/u.test(character) && depth === 0) {
            if (i > start) result.push(value.slice(start, i));
            start = i + 1;
        }
    }
    if (depth || quote) return null;
    if (start < value.length) result.push(value.slice(start));
    return result;
}

function property(nativeName: string, parse: ValueParser, syntax: string, partKind?: 'text'): NativeDeclarationDescriptor {
    return {
        syntax,
        ...(partKind ? { partKind } : {}),
        convert(value) {
            const parsed = parse(value);
            return parsed === null ? null : { [nativeName]: parsed };
        },
    };
}

function keywords(nativeName: string, values: readonly string[], partKind?: 'text'): NativeDeclarationDescriptor {
    return property(nativeName, value => values.includes(value.toLowerCase()) ? value.toLowerCase() : null, values.join(' | '), partKind);
}

function fourValues(names: readonly string[], parse: ValueParser, syntax: string): NativeDeclarationDescriptor {
    return {
        syntax,
        convert(value) {
            const parts = components(value);
            if (!parts || parts.length < 1 || parts.length > 4) return null;
            const parsed: NativeValue[] = [];
            for (const part of parts) {
                const converted = parse(part);
                if (converted === null) return null;
                parsed.push(converted);
            }
            const [a, b = a, c = a, d = b] = parsed;
            return Object.fromEntries(names.map((name, index) => [name, [a, b, c, d][index]!]));
        },
    };
}

const length = dimension();
const nonNegativePercentLength = dimension({ percent: true });
const marginLength = dimension({ percent: true, negative: true, auto: true });
const lengthSyntax = '0 | <px> | <pt>';
const percentLengthSyntax = `${lengthSyntax} | <percentage>`;
const marginSyntax = `auto | ${percentLengthSyntax} (negative allowed)`;
const textAlignments = ['auto', 'left', 'right', 'center', 'justify'] as const;
const itemAlignments = ['flex-start', 'flex-end', 'center', 'stretch', 'baseline'] as const;

const flex: NativeDeclarationDescriptor = {
    syntax: 'none | auto | initial | [<grow> [<shrink>]] || <basis>',
    convert(value) {
        value = value.toLowerCase();
        if (value === 'none') return { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' };
        if (value === 'auto') return { flexGrow: 1, flexShrink: 1, flexBasis: 'auto' };
        if (value === 'initial') return { flexGrow: 0, flexShrink: 1, flexBasis: 'auto' };
        const parts = components(value);
        if (!parts || parts.length < 1 || parts.length > 3) return null;
        const parseBasis = dimension({ percent: true, auto: true });
        const firstNumber = nonNegativeNumber(parts[0]!);
        if (firstNumber === null) {
            const basis = parseBasis(parts[0]!);
            const grow = parts.length >= 2 ? nonNegativeNumber(parts[1]!) : 1;
            const shrink = parts.length === 3 ? nonNegativeNumber(parts[2]!) : 1;
            return basis === null || grow === null || shrink === null
                ? null : { flexGrow: grow, flexShrink: shrink, flexBasis: basis };
        }
        const secondNumber = parts.length >= 2 ? nonNegativeNumber(parts[1]!) : null;
        if (parts.length === 3 && secondNumber === null) return null;
        const basis = parts.length === 3 ? parseBasis(parts[2]!)
            : parts.length === 2 && secondNumber === null ? parseBasis(parts[1]!) : '0%';
        return basis === null ? null : { flexGrow: firstNumber, flexShrink: secondNumber ?? 1, flexBasis: basis };
    },
};

const border: NativeDeclarationDescriptor = {
    syntax: '<width> solid <literal colour> (any order)',
    convert(value) {
        const parts = components(value);
        if (!parts || parts.length !== 3) return null;
        let width: number | null = null;
        let color: string | null = null;
        let solid = false;
        for (const part of parts) {
            if (part.toLowerCase() === 'solid' && !solid) {
                solid = true;
                continue;
            }
            const parsedWidth = length(part);
            if (width === null && typeof parsedWidth === 'number') {
                width = parsedWidth;
                continue;
            }
            const parsedColor = literalColor(part);
            if (color === null && parsedColor !== null) color = parsedColor;
            else return null;
        }
        if (!solid || width === null || color === null) return null;
        return {
            ...Object.fromEntries(sides.map(side => [`border${side}Width`, width])),
            borderStyle: 'solid',
            ...Object.fromEntries(sides.map(side => [`border${side}Color`, color])),
        };
    },
};

/** The compiler and authoring guide consume this same property/value authority. */
export const NATIVE_DECLARATION_CONVERSIONS: Readonly<Record<string, NativeDeclarationDescriptor>> = Object.freeze({
    background: property('backgroundColor', literalColor, '<literal colour>'),
    'background-color': property('backgroundColor', literalColor, '<literal colour>'),
    color: property('color', literalColor, '<literal colour>', 'text'),
    opacity: property('opacity', value => {
        const percent = value.endsWith('%');
        const number = parseNumber(percent ? value.slice(0, -1) : value);
        return number === null ? null : Math.min(1, Math.max(0, percent ? number / 100 : number));
    }, '<number> | <percentage> (clamped to 0–1)'),
    ...Object.fromEntries(['width', 'height'].map(name => [name,
        property(name, dimension({ percent: true, auto: true }), `auto | ${percentLengthSyntax}`)])),
    ...Object.fromEntries(['min', 'max'].flatMap(prefix => ['width', 'height'].map(axis => [
        `${prefix}-${axis}`, property(`${prefix}${axis === 'width' ? 'Width' : 'Height'}`, nonNegativePercentLength, percentLengthSyntax),
    ]))),
    margin: fourValues(sides.map(side => `margin${side}`), marginLength, `1–4 × (${marginSyntax})`),
    padding: fourValues(sides.map(side => `padding${side}`), nonNegativePercentLength, `1–4 × (${percentLengthSyntax})`),
    ...Object.fromEntries(sides.flatMap(side => [
        [`margin-${side.toLowerCase()}`, property(`margin${side}`, marginLength, marginSyntax)],
        [`padding-${side.toLowerCase()}`, property(`padding${side}`, nonNegativePercentLength, percentLengthSyntax)],
        [`border-${side.toLowerCase()}-width`, property(`border${side}Width`, length, lengthSyntax)],
        [`border-${side.toLowerCase()}-color`, property(`border${side}Color`, literalColor, '<literal colour>')],
    ])),
    gap: {
        syntax: `1–2 × (${percentLengthSyntax})`,
        convert(value) {
            const parts = components(value);
            if (!parts || parts.length < 1 || parts.length > 2) return null;
            const rowGap = nonNegativePercentLength(parts[0]!);
            const columnGap = nonNegativePercentLength(parts[1] ?? parts[0]!);
            return rowGap === null || columnGap === null ? null : { rowGap, columnGap };
        },
    },
    'row-gap': property('rowGap', nonNegativePercentLength, percentLengthSyntax),
    'column-gap': property('columnGap', nonNegativePercentLength, percentLengthSyntax),
    flex,
    'flex-direction': keywords('flexDirection', ['row', 'column', 'row-reverse', 'column-reverse']),
    'flex-wrap': keywords('flexWrap', ['nowrap', 'wrap', 'wrap-reverse']),
    'flex-grow': property('flexGrow', nonNegativeNumber, '<non-negative number>'),
    'flex-shrink': property('flexShrink', nonNegativeNumber, '<non-negative number>'),
    'flex-basis': property('flexBasis', dimension({ percent: true, auto: true }), `auto | ${percentLengthSyntax}`),
    'align-items': keywords('alignItems', itemAlignments),
    'align-self': keywords('alignSelf', ['auto', ...itemAlignments]),
    'align-content': keywords('alignContent', ['flex-start', 'flex-end', 'center', 'stretch', 'space-between', 'space-around', 'space-evenly']),
    'justify-content': keywords('justifyContent', ['flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly']),
    position: keywords('position', ['relative', 'absolute', 'static']),
    ...Object.fromEntries(sides.map(side => [side.toLowerCase(), property(side.toLowerCase(),
        dimension({ percent: true, negative: true, auto: true }), marginSyntax)])),
    'z-index': property('zIndex', value => {
        const number = parseNumber(value);
        return number !== null && Number.isInteger(number) ? number : null;
    }, '<integer>'),
    border,
    'border-width': fourValues(sides.map(side => `border${side}Width`), length, `1–4 × (${lengthSyntax})`),
    'border-color': fourValues(sides.map(side => `border${side}Color`), literalColor, '1–4 × <literal colour>'),
    'border-style': keywords('borderStyle', ['solid']),
    'border-radius': fourValues(corners.map(corner => `border${corner}Radius`), nonNegativePercentLength, `1–4 × (${percentLengthSyntax}); circular radii only`),
    ...Object.fromEntries(corners.map(corner => [
        `border-${corner.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`).slice(1)}-radius`,
        property(`border${corner}Radius`, nonNegativePercentLength, percentLengthSyntax),
    ])),
    display: keywords('display', ['none', 'flex']),
    overflow: keywords('overflow', ['visible', 'hidden']),
    'font-size': property('fontSize', length, lengthSyntax, 'text'),
    'font-family': property('fontFamily', value => {
        const family = /^(?:"([^"\\]*)"|'([^'\\]*)'|([^\s,"'\\]+))$/u.exec(value);
        const name = family?.[1] ?? family?.[2] ?? family?.[3];
        return name !== undefined && bundledFonts.has(name) ? name : null;
    }, 'one bundled font family (optionally quoted)', 'text'),
    'font-weight': keywords('fontWeight', ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'], 'text'),
    'font-style': keywords('fontStyle', ['normal', 'italic'], 'text'),
    'line-height': property('lineHeight', length, lengthSyntax, 'text'),
    'letter-spacing': property('letterSpacing', dimension({ negative: true }), `${lengthSyntax} (negative allowed)`, 'text'),
    'text-align': keywords('textAlign', textAlignments, 'text'),
    'text-transform': keywords('textTransform', ['none', 'capitalize', 'uppercase', 'lowercase'], 'text'),
    'text-decoration-line': {
        syntax: 'none | underline | line-through | underline line-through',
        partKind: 'text',
        convert(value) {
            if (value === 'none') return { textDecorationLine: 'none' };
            const parts = components(value);
            if (!parts || parts.length < 1 || parts.length > 2 || new Set(parts).size !== parts.length
                || parts.some(part => part !== 'underline' && part !== 'line-through')) return null;
            return { textDecorationLine: ['underline', 'line-through'].filter(part => parts.includes(part)).join(' ') };
        },
    },
});

export function convertNativeDeclaration(property: string, value: string, partKind?: 'view' | 'text'): NativeDeclarationConversion {
    const descriptor = Object.hasOwn(NATIVE_DECLARATION_CONVERSIONS, property)
        ? NATIVE_DECLARATION_CONVERSIONS[property] : undefined;
    if (!descriptor) return { supported: false, reason: 'property' };
    if (partKind === 'view' && descriptor.partKind === 'text') return { supported: false, reason: 'property' };
    const style = descriptor.convert(value.trim());
    return style === null ? { supported: false, reason: 'value' } : { supported: true, style };
}
