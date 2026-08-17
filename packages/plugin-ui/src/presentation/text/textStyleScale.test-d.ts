import {
  scaleTextStyleMetrics,
  type TextStyleEntryTransform,
} from './textStyleScale.js';
import type { HappierStyleProp } from '../portableTypes.js';

type Assert<Condition extends true> = Condition;
type IsAssignable<From, To> = From extends To ? true : false;
type IsEqual<Left, Right> = (
  <T>() => T extends Left ? 1 : 2
) extends (
  <T>() => T extends Right ? 1 : 2
) ? true : false;

type ShapePreservingTransform = <T extends object>(entry: T, textScale: number) => T;
type ErasesOpaqueHostFields = () => { fontSize: number };

type _ShapePreservingTransformRemainsAccepted = Assert<
  IsAssignable<ShapePreservingTransform, TextStyleEntryTransform>
>;

// A transform that returns a fresh style object cannot promise to retain a
// caller's opaque host fields for every possible entry shape.
type _ErasingTransformIsRejected = Assert<
  IsAssignable<ErasesOpaqueHostFields, TextStyleEntryTransform> extends false ? true : false
>;

type LiteralMetricStyle = Readonly<{
  hostToken: 'opaque-host-token';
  fontSize: 10;
  lineHeight: 12;
  letterSpacing: 0.5;
}>;

type ScaledLiteralMetricStyle = ReturnType<typeof scaleTextStyleMetrics<LiteralMetricStyle>>;

type _ScaledMetricLiteralsWidenWithoutErasingHostFields = Assert<IsEqual<
  ScaledLiteralMetricStyle,
  Readonly<{
    hostToken: 'opaque-host-token';
    fontSize: number;
    lineHeight: number;
    letterSpacing: number;
  }>
>>;

// The public text prop is recursively defined. It deliberately consumes the
// canonical broad style union rather than recursively expanding a mapped type
// at every nested array entry.
type ScaledHappierStyleProp = ReturnType<typeof scaleTextStyleMetrics<HappierStyleProp>>;
type _RecursivePublicStyleUsesTheCanonicalBoundary = Assert<IsEqual<
  ScaledHappierStyleProp,
  HappierStyleProp
>>;
