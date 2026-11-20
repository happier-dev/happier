import type { GlyphInkMap } from '@happier-dev/brand/glyph-scene';
import type { SkImage } from '@shopify/react-native-skia';
import type { FocusReturnTarget } from '@/keyboard/focusReturn';
import type { View } from 'react-native';
import type { WindowFlightRect } from '../rectFlipGeometry';

export type StepAnchor = Readonly<{ testID?: string; rect: WindowFlightRect }>;
export type StepMoveKind = 'step' | 'back' | 'notice' | 'home';
export type StepMove<T = void> = Readonly<{
    layer: string;
    kind: StepMoveKind;
    commit: () => T;
    fromWelcome?: boolean;
    toWelcome?: boolean;
    onSettled?: (outcome: StepBuildResult) => void;
}>;

export type StepBuild = Readonly<{
    layer: string;
    choreography: 'opening' | 'home';
    epoch?: number;
    leadSeconds?: number;
}>;

export type StepBuildResult = 'settled' | 'skipped';

export type StepGrid = Readonly<{ width: number; height: number; cols: number; rows: number; cell: readonly [number, number] }>;
export type StepWebLeaf = Readonly<{ element: HTMLElement; rect: WindowFlightRect }>;
export type StepFreeze = Readonly<{
    rect: WindowFlightRect;
    clone?: HTMLElement;
    image?: SkImage;
    ink?: GlyphInkMap;
    control?: HTMLElement | null;
    webLeaves?: readonly StepWebLeaf[];
    webFocal?: HTMLElement;
    webChrome?: readonly HTMLElement[];
    release: () => void;
}>;

export type StepMotionLayerHandle = Readonly<{
    key: string;
    backTestID?: string;
    compact: boolean;
    warmOnMount: boolean;
    webElement: () => HTMLElement | null;
    webChrome?: () => readonly HTMLElement[];
    nativeElement: () => View | null;
    focal: (returnTo?: string) => FocusReturnTarget;
    paintOpacity: (values: readonly number[], durationMs: number, delayMs: number) => () => void;
    focus: (returnTo?: string, allowLateFocal?: boolean) => void;
    fadeIn: (onSettled: () => void, rise: boolean) => () => void;
}>;
