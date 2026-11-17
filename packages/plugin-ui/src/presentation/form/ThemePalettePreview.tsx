import * as React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import type { HappierUiTheme } from '../../environment/types.js';
import type { HappierPortableStyle } from '../portableTypes.js';

export type ThemePreviewPalette = Readonly<{
    dark?: boolean;
    colors: Readonly<{
        background: Readonly<{ canvas: string }>;
        surface: Readonly<{ base: string; elevated: string; selected?: string }>;
        text?: Readonly<{ primary: string }>;
        border: Readonly<{ default: string; strong: string }>;
        /** The surface ladder: Elements and floating fills (absent on palettes that predate it). */
        edge?: Readonly<{ cardFill: string; floatingFill: string }>;
        /** The theme's accent (the send mark); a resolved theme carries it, compact palettes pass `accent`. */
        button?: Readonly<{ primary: Readonly<{ background: string }> }>;
        /** Your message's fill (the bubble); falls back to the elevated surface. */
        message?: Readonly<{ user: Readonly<{ background: string }> }>;
    }>;
}>;

/**
 * Which picture of the app the miniature draws: `window` (rail, session column, transcript and
 * composer), `phone` (large title, session rows, floating tab bar and the accent +) for pickers shown
 * on a phone, or `mark` (the transcript corner alone, for a 44 pt header mark or a 32×20 command row).
 */
export type ThemeMiniatureForm = 'window' | 'phone' | 'mark';

/** Already-resolved material paints, supplied by the host's glass owner. */
export type ThemePreviewPaint = Readonly<{
    chrome?: string;
    sidebar?: string;
    content?: string;
    card?: string;
    floating?: string;
    rootStyle?: HappierPortableStyle;
    floatingStyle?: HappierPortableStyle;
}>;

export type ThemePalettePreviewProps = Readonly<{
    palette: ThemePreviewPalette;
    paint?: ThemePreviewPaint;
    backdrop?: React.ReactNode;
    floatingOnly?: boolean;
    accent?: string;
    /** Corner radius at miniature scale; the default is today's soft shape. */
    radius?: number;
    form?: ThemeMiniatureForm;
    /** Prepared supported styles from an opened theme; this drawing never compiles CSS. */
    surfaceStyles?: HappierUiTheme['surfaces'];
}>;

const PILL = 999;
const SESSION_ROWS = [0, 1, 2, 3, 4] as const;
const share = (percent: number): `${number}%` => `${percent}%`;
type MiniatureSurfaceStyle = NonNullable<HappierUiTheme['surfaces']>[string][string]['base'];

/** Static window, phone and transcript-corner drawing shared by host and plugin theme pickers. */
export function ThemePalettePreview(props: ThemePalettePreviewProps) {
    const c = props.palette.colors;
    const surfaces = props.surfaceStyles;
    const rows = surfaces?.['session-row']?.root;
    const radius = props.radius ?? 5;
    const floatingFill = c.edge?.floatingFill ?? c.surface.base;
    const ink = c.text?.primary ?? c.border.strong;
    const accent = props.accent ?? c.button?.primary.background ?? ink;
    // Ink at a share of its strength: the miniature's text lines and glyphs.
    const inkBar = (style: ViewStyle, strength: number, override?: MiniatureSurfaceStyle) => (
        <View style={[{ position: 'absolute', borderRadius: PILL, backgroundColor: ink, opacity: strength }, style, override]} />
    );

    if (props.floatingOnly) {
        const line = (width: `${number}%`, marginTop = 5) => (
            <View style={{ height: 5, borderRadius: 3, width, backgroundColor: c.border.strong, marginTop }} />
        );
        return (
            <View style={[{ flex: 1, flexDirection: 'row', overflow: 'hidden', backgroundColor: props.backdrop ? 'transparent' : c.background.canvas }, props.paint?.rootStyle]}>
              {props.backdrop}
              <View style={{ flex: 1, padding: 12, backgroundColor: c.surface.base }}>
                {line('92%', 0)}
                {line('65%')}
                {line('82%')}
                <View style={{ position: 'absolute', left: 12, right: 12, bottom: 8, height: 38, overflow: 'hidden', borderRadius: 12 }}>
                    {/* The lab's coloured page remains behind the floating coat on this device. */}
                    {props.backdrop}
                    <View style={[{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', borderRadius: 12, backgroundColor: props.paint?.floating ?? floatingFill, borderWidth: 1, borderColor: c.border.default }, props.paint?.floatingStyle]}>
                        {[0, 1, 2, 3].map(id => <View key={id} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.border.strong }} />)}
                    </View>
                </View>
              </View>
            </View>
        );
    }

    const selectedRow = c.surface.selected ?? c.surface.elevated;
    const form = props.form ?? 'window';
    if (form === 'phone') {
        return (
            <View style={{ flex: 1, overflow: 'hidden', backgroundColor: c.surface.base }}>
                {inkBar({ top: '9%', left: '8%', width: '42%', height: '5%' }, 0.72)}
                {SESSION_ROWS.map((row) => (
                    <View key={row} style={[{ position: 'absolute', left: '6%', right: '6%', top: share(19 + row * 13), height: '11%', borderRadius: radius, backgroundColor: row === 0 ? selectedRow : undefined }, row === 0 ? rows?.states.selected ?? rows?.base : rows?.base]}>
                        {inkBar({ top: '24%', left: '5%', width: '64%', height: '22%' }, row === 0 ? 0.55 : 0.3)}
                        {inkBar({ top: '58%', left: '5%', width: '38%', height: '17%' }, 0.14)}
                    </View>
                ))}
                <View style={{ position: 'absolute', left: '8%', width: '62%', bottom: '5%', height: '10%', borderRadius: PILL, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border.default, backgroundColor: c.surface.base, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' }}>
                    {[0, 1, 2, 3].map((dot) => <View key={dot} style={{ height: '30%', aspectRatio: 1, borderRadius: PILL, backgroundColor: ink, opacity: 0.3 }} />)}
                </View>
                <View style={{ position: 'absolute', right: '8%', bottom: '5%', height: '10%', aspectRatio: 1, borderRadius: PILL, backgroundColor: accent }} />
            </View>
        );
    }

    const bubbleFill = props.paint?.card ?? c.message?.user.background ?? c.surface.elevated;
    const composerFill = props.paint?.card ?? c.surface.base;
    // The transcript: a title, your message, the agent's reply and the composer with the accent send.
    const transcript = (
        <>
            {inkBar({ top: '8%', left: '7%', width: '34%', height: '3.6%' }, 0.7, surfaces?.['chat-header']?.title?.base)}
            <View style={[{ position: 'absolute', top: '19%', right: '7%', width: '44%', height: '11%', borderRadius: radius * 1.1, backgroundColor: bubbleFill }, surfaces?.['user-bubble']?.root?.base]} />
            {inkBar({ top: '37%', left: '7%', width: '67%', height: '3%' }, 0.2, surfaces?.['assistant-text']?.paragraph?.base)}
            {inkBar({ top: '44%', left: '7%', width: '55%', height: '3%' }, 0.2, surfaces?.['assistant-text']?.paragraph?.base)}
            {inkBar({ top: '51%', left: '7%', width: '61%', height: '3%' }, 0.2, surfaces?.['assistant-text']?.paragraph?.base)}
            <View style={[{ position: 'absolute', left: '7%', right: '7%', bottom: '6%', height: '13%', borderRadius: radius * 1.2, backgroundColor: composerFill, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border.default, alignItems: 'flex-end', justifyContent: 'center', paddingRight: '2.5%' }, surfaces?.composer?.root?.base]}>
                <View style={[{ height: '56%', aspectRatio: 1, borderRadius: PILL, backgroundColor: accent }, surfaces?.composer?.send?.base]} />
            </View>
        </>
    );
    const mainFill = props.paint?.content ?? c.surface.base;
    if (form === 'mark') {
        return (
            <View style={{ flex: 1, overflow: 'hidden', backgroundColor: c.background.canvas }}>
                <View style={{ position: 'absolute', top: '12%', left: '12%', right: 0, bottom: 0, borderTopLeftRadius: radius, backgroundColor: mainFill, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border.default }}>
                    {transcript}
                </View>
            </View>
        );
    }
    return (
        <View style={[{ flex: 1, overflow: 'hidden', backgroundColor: props.backdrop ? 'transparent' : c.background.canvas }, props.paint?.rootStyle]}>
            {props.backdrop}
            {props.paint?.chrome !== undefined ? <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '9%', backgroundColor: props.paint.chrome }} /> : null}
            <View style={{ position: 'absolute', left: 0, width: '9%', top: '9%', height: '36%', alignItems: 'center', justifyContent: 'space-between' }}>
                {[0, 1, 2, 3].map((dot) => <View key={dot} style={{ width: '38%', aspectRatio: 1, borderRadius: Math.min(radius, 2), backgroundColor: ink, opacity: 0.2 }} />)}
            </View>
            <View style={[{ position: 'absolute', left: '10.8%', width: '27%', top: '4%', bottom: '4%', borderRadius: radius, backgroundColor: props.paint?.sidebar }, surfaces?.sidebar?.root?.base]}>
                {SESSION_ROWS.map((row) => (
                    <View key={row} style={[{ position: 'absolute', left: '6%', right: '6%', top: share(4 + row * 12.5), height: '9.8%', borderRadius: Math.max(1, radius * 0.7), backgroundColor: row === 0 ? selectedRow : undefined }, row === 0 ? rows?.states.selected ?? rows?.base : rows?.base]}>
                        {inkBar({ top: '36%', left: '8%', width: '66%', height: '28%' }, row === 0 ? 0.55 : 0.2)}
                    </View>
                ))}
            </View>
            <View style={{ position: 'absolute', left: '39.6%', right: '2.6%', top: '4%', bottom: '4%', borderRadius: radius, backgroundColor: mainFill, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border.default, overflow: 'hidden' }}>
                {transcript}
            </View>
        </View>
    );
}
