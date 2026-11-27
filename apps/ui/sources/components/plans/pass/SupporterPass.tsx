import * as React from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Defs, G, LinearGradient, Mask, Path, RadialGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';

import { QRCode } from '@/components/qr';
import { Text } from '@/components/ui/text/Text';
import { motionTokens, resolveMotionPresentation } from '@/components/ui/motion';
import { getDefaultFont, getMonoFont, Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { SupporterPassStyleId } from '@/sync/domains/settings/registry/local/supporterPassStyleSetting';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { formatMonthYear, formatSupporterNumber } from '../planSurfaceCopy';
import {
    PASS_ART_BOX,
    PASS_MARK_PATH,
    PASS_PALETTES,
    PASS_SMILE_PATH,
    passMaterialForFinish,
    type PassMaterial,
    type PassPalette,
} from './passArt';
import { passArtKey, passArtSpec, type PassArtGradient, type PassArtLayer, type PassPaint } from './passArtStyles';

export type SupporterPassIdentity = Readonly<{
    number: number;
    name: string | null;
    sinceMs: number | null;
}>;

export type SupporterPassProps = Readonly<{
    /** The edition's printed name: the plan name from the server, or "Supporter". */
    editionLabel: string;
    /** Null draws the blank pass someone sees before joining: no number and no code. */
    identity: SupporterPassIdentity | null;
    width: number;
}>;

/** The wordmark is the product's logotype, printed on the object like the mark beside it. */
const WORDMARK = 'happier';
const PASS_ASPECT_RATIO = 0.72;
const SUPPORTER_PAGE_ORIGIN = 'https://happier.dev/s/';


/** Every size on the pass is a fraction of its width, so it aligns at 120 px and at 360 px. */
function passMetrics(width: number) {
    return {
        height: width / PASS_ASPECT_RATIO,
        radius: width * 0.069,
        inset: width * 0.077,
        rowGap: width * 0.062,
        mark: width * 0.077,
        headerGap: width * 0.031,
        wordmark: width * 0.058,
        label: width * 0.034,
        number: width * 0.154,
        field: width * 0.05,
        qr: width * 0.3,
        qrPad: width * 0.023,
        url: width * 0.031,
        bareMark: width * 0.16,
    };
}

const PassMark = React.memo(function PassMark(props: Readonly<{ size: number; palette: PassPalette; opacity?: number }>) {
    return (
        <Svg width={props.size} height={props.size} viewBox="0 0 100 100" opacity={props.opacity}>
            <Path d={PASS_MARK_PATH} fill={props.palette.foreground} />
            <Path d={PASS_SMILE_PATH} fill="none" stroke={props.palette.markCutout} strokeWidth={7.5} strokeLinecap="round" />
        </Svg>
    );
});

type PaintResolver = (paint: PassPaint | undefined) => string | undefined;

function renderGradient(gradient: PassArtGradient, prefix: string) {
    const stops = gradient.stops.map(([offset, color, opacity], index) => (
        <Stop key={index} offset={offset} stopColor={color} stopOpacity={opacity ?? 1} />
    ));
    if (gradient.kind === 'linear') {
        return (
            <LinearGradient
                key={gradient.id}
                id={`${prefix}${gradient.id}`}
                gradientUnits={gradient.units === 'user' ? 'userSpaceOnUse' : 'objectBoundingBox'}
                x1={gradient.x1}
                y1={gradient.y1}
                x2={gradient.x2}
                y2={gradient.y2}
            >
                {stops}
            </LinearGradient>
        );
    }
    return (
        <RadialGradient
            key={gradient.id}
            id={`${prefix}${gradient.id}`}
            gradientUnits="userSpaceOnUse"
            cx={gradient.cx}
            cy={gradient.cy}
            r={gradient.r}
            gradientTransform={gradient.scaleY === undefined ? undefined : `translate(0 ${gradient.cy}) scale(1 ${gradient.scaleY}) translate(0 ${-gradient.cy})`}
        >
            {stops}
        </RadialGradient>
    );
}

function renderLayer(layer: PassArtLayer, key: number, prefix: string, resolve: PaintResolver): React.ReactNode {
    switch (layer.kind) {
        case 'fill':
            return <Rect key={key} width={PASS_ART_BOX.width} height={PASS_ART_BOX.height} fill={resolve(layer.paint)} opacity={layer.opacity} />;
        case 'path':
            return (
                <Path key={key} d={layer.d} fill={resolve(layer.fill) ?? 'none'} stroke={resolve(layer.stroke)} strokeWidth={layer.strokeWidth} opacity={layer.opacity} />
            );
        case 'circle':
            return (
                <Circle
                    key={key}
                    cx={layer.cx}
                    cy={layer.cy}
                    r={layer.r}
                    fill={resolve(layer.fill) ?? 'none'}
                    stroke={resolve(layer.stroke)}
                    strokeWidth={layer.strokeWidth}
                    opacity={layer.opacity}
                />
            );
        case 'text':
            return (
                <SvgText
                    key={key}
                    x={layer.x}
                    y={layer.y}
                    fontFamily={layer.font === 'mono' ? getMonoFont() : getDefaultFont('semiBold')}
                    fontWeight={layer.font === 'mono' ? undefined : '600'}
                    fontSize={layer.size}
                    letterSpacing={layer.letterSpacing}
                    textAnchor={layer.anchor}
                    fill={resolve(layer.fill) ?? 'none'}
                    stroke={resolve(layer.stroke)}
                    strokeWidth={layer.strokeWidth}
                    opacity={layer.opacity}
                >
                    {layer.text}
                </SvgText>
            );
        case 'masked':
            return (
                <G key={key} mask={`url(#${prefix}mask-${layer.mask})`}>
                    {layer.layers.map((inner, index) => renderLayer(inner, index, prefix, resolve))}
                </G>
            );
    }
}

/**
 * The pass's art in the chosen style (lab round 5b). Gradient ids carry the style, material and,
 * for numbered arts, the number, so two passes on one web page never resolve each other's defs.
 */
const PassArt = React.memo(function PassArt(props: Readonly<{
    style: SupporterPassStyleId;
    material: PassMaterial;
    number: number | null;
    width: number;
    height: number;
}>) {
    const art = passArtSpec(props.style, props.material, props.number);
    const prefix = `pass-${passArtKey(props.style, props.material, props.number)}-`;
    const resolve: PaintResolver = (paint) => (paint === undefined ? undefined : typeof paint === 'string' ? paint : `url(#${prefix}${paint.gradient})`);
    const masks = art.layers.flatMap((layer) => (layer.kind === 'masked' ? [layer.mask] : []));
    return (
        <Svg width={props.width} height={props.height} viewBox={`0 0 ${PASS_ART_BOX.width} ${PASS_ART_BOX.height}`} preserveAspectRatio="none" style={ART_STYLE}>
            <Defs>
                {art.gradients.map((gradient) => renderGradient(gradient, prefix))}
                {masks.map((mask) => (
                    <Mask key={mask} id={`${prefix}mask-${mask}`} maskUnits="userSpaceOnUse" x={0} y={0} width={PASS_ART_BOX.width} height={PASS_ART_BOX.height}>
                        <Rect width={PASS_ART_BOX.width} height={PASS_ART_BOX.height} fill={`url(#${prefix}${mask})`} />
                    </Mask>
                ))}
            </Defs>
            {art.layers.map((layer, index) => renderLayer(layer, index, prefix, resolve))}
        </Svg>
    );
});

const ART_STYLE = { position: 'absolute', left: 0, top: 0 } as const;

function PassFace(props: Readonly<{
    palette: PassPalette;
    editionLabel: string;
    identity: SupporterPassIdentity | null;
    width: number;
}>) {
    const m = passMetrics(props.width);
    const { palette, identity } = props;
    const number = identity ? formatSupporterNumber(identity.number) : null;
    const labelStyle = {
        ...Typography.mono(),
        fontSize: m.label,
        lineHeight: m.label * 1.2,
        letterSpacing: m.label * 0.12,
        textTransform: 'uppercase' as const,
        color: palette.foreground,
        opacity: 0.55,
    };
    const valueStyle = {
        ...Typography.default('semiBold'),
        fontSize: m.field,
        lineHeight: m.field * 1.25,
        color: palette.foreground,
    };
    return (
        <View style={{ flex: 1, padding: m.inset, gap: m.rowGap }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', height: m.mark, gap: m.headerGap }}>
                <PassMark size={m.mark} palette={palette} />
                <Text allowFontScaling={false} style={{ ...Typography.default('semiBold'), fontSize: m.wordmark, lineHeight: m.wordmark, letterSpacing: -m.wordmark * 0.02, color: palette.foreground }}>
                    {WORDMARK}
                </Text>
                <View style={{ flex: 1 }} />
                <Text allowFontScaling={false} style={[labelStyle, { opacity: 0.7 }]}>{props.editionLabel}</Text>
            </View>
            <View>
                <Text allowFontScaling={false} style={labelStyle}>{t('planSurface.passSupporterNo')}</Text>
                <Text
                    allowFontScaling={false}
                    style={{
                        ...Typography.default(),
                        fontSize: m.number,
                        lineHeight: m.number,
                        letterSpacing: -m.number * 0.035,
                        fontVariant: ['tabular-nums'],
                        color: palette.foreground,
                        marginTop: props.width * 0.015,
                    }}
                >
                    {number ?? '····'}
                </Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: props.width * 0.06 }}>
                <View style={{ flexShrink: 1, gap: props.width * 0.015 }}>
                    <Text allowFontScaling={false} style={labelStyle}>{t('planSurface.passName')}</Text>
                    <Text allowFontScaling={false} numberOfLines={1} style={valueStyle}>
                        {identity?.name ?? t('planSurface.passYou')}
                    </Text>
                </View>
                <View style={{ alignItems: 'flex-end', gap: props.width * 0.015 }}>
                    <Text allowFontScaling={false} style={labelStyle}>{t('planSurface.passSince')}</Text>
                    <Text allowFontScaling={false} style={valueStyle}>
                        {identity?.sinceMs ? formatMonthYear(identity.sinceMs) : t('planSurface.passToday')}
                    </Text>
                </View>
            </View>
            <View style={{ flex: 1, justifyContent: 'flex-end', alignItems: 'center', gap: props.width * 0.02 }}>
                {number ? (
                    <>
                        <View style={{ width: m.qr, height: m.qr, padding: m.qrPad, borderRadius: m.qrPad, backgroundColor: palette.qrBackground }}>
                            <QRCode
                                data={`${SUPPORTER_PAGE_ORIGIN}${number}`}
                                size={m.qr - m.qrPad * 2}
                                foregroundColor={palette.qrForeground}
                                backgroundColor={palette.qrBackground}
                            />
                        </View>
                        <Text allowFontScaling={false} style={{ ...Typography.mono(), fontSize: m.url, color: palette.foreground, opacity: 0.55 }}>
                            {`happier.dev/s/${number}`}
                        </Text>
                    </>
                ) : (
                    // Before joining there is no code to show, so the slot holds the bare mark
                    // instead of a fake QR.
                    <PassMark size={m.bareMark} palette={palette} opacity={0.22} />
                )}
            </View>
        </View>
    );
}

/**
 * The Supporter pass (plan 04 U2): a portrait object in this device's finish, blank before
 * joining and numbered after. When the number arrives while the pass is on screen it turns over
 * once to show it; under reduced motion it cross-fades instead. Screen readers get one image.
 */
export const SupporterPass = React.memo(function SupporterPass(props: SupporterPassProps) {
    // The art and finish are this device's choice; the edition is the label the pass prints.
    const style = useLocalSetting('supporterPassStyle');
    const material = passMaterialForFinish(useLocalSetting('supporterPassFinish'));
    const palette = PASS_PALETTES[material];
    const m = passMetrics(props.width);
    const reducedMotion = useReducedMotionPreference();
    const [shownIdentity, setShownIdentity] = React.useState(props.identity);
    const turn = useSharedValue(0);
    const fade = useSharedValue(1);

    const joinedNumber = props.identity?.number ?? null;
    const shownNumber = shownIdentity?.number ?? null;
    React.useEffect(() => {
        if (joinedNumber === shownNumber) {
            if (props.identity !== shownIdentity) setShownIdentity(props.identity);
            return;
        }
        // Only the moment of joining is a turn; any other change (a refund, a Home switch) swaps.
        if (shownNumber !== null || joinedNumber === null) {
            setShownIdentity(props.identity);
            return;
        }
        const next = props.identity;
        const swap = () => setShownIdentity(next);
        const half = motionTokens.durationMs.slow;
        if (resolveMotionPresentation('supporterPassJoin', reducedMotion) === 'animate') {
            turn.value = withTiming(90, { duration: half, easing: Easing.in(Easing.cubic) }, (finished) => {
                if (!finished) return;
                runOnJS(swap)();
                turn.value = withTiming(0, { duration: half, easing: motionTokens.easing.standard });
            });
        } else {
            fade.value = withTiming(0, { duration: motionTokens.durationMs.fast }, (finished) => {
                if (!finished) return;
                runOnJS(swap)();
                fade.value = withTiming(1, { duration: motionTokens.durationMs.base });
            });
        }
    }, [fade, joinedNumber, props.identity, reducedMotion, shownIdentity, shownNumber, turn]);

    const motionStyle = useAnimatedStyle(() => ({
        opacity: fade.value,
        transform: [{ perspective: 900 }, { rotateY: `${turn.value}deg` }],
    }));

    const accessibilityLabel = shownIdentity
        ? t('planSurface.passA11y', {
            edition: props.editionLabel,
            number: formatSupporterNumber(shownIdentity.number),
            name: shownIdentity.name ?? t('planSurface.passYou'),
            since: shownIdentity.sinceMs ? formatMonthYear(shownIdentity.sinceMs) : t('planSurface.passToday'),
        })
        : t('planSurface.passBlankA11y');

    const frame: ViewStyle = {
        width: props.width,
        height: m.height,
        borderRadius: m.radius,
        overflow: 'hidden',
        borderWidth: Platform.OS === 'web' ? 0 : 1,
        borderColor: palette.edge,
    };

    return (
        <Animated.View
            accessible
            accessibilityRole="image"
            accessibilityLabel={accessibilityLabel}
            style={[
                {
                    width: props.width,
                    height: m.height,
                    borderRadius: m.radius,
                    boxShadow: `inset 0 0 0 1px ${palette.edge}, 0 ${m.radius * 1.5}px ${m.radius * 3}px -${m.radius * 1.2}px ${palette.shadow}`,
                },
                motionStyle,
            ]}
        >
            <View style={frame} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <PassArt style={style} material={material} number={shownIdentity?.number ?? null} width={props.width} height={m.height} />
                <PassFace palette={palette} editionLabel={props.editionLabel} identity={shownIdentity} width={props.width} />
            </View>
        </Animated.View>
    );
});
