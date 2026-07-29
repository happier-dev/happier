import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const motionState = vi.hoisted(() => ({
    level: 'full' as 'full' | 'subtle' | 'minimal',
}));

vi.mock('./motion/useMotionPreferences', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./motion/useMotionPreferences')>();
    return {
        ...actual,
        useMotionPreferences: () => actual.resolveMotionPreferences({
            visualEffectsLevel: motionState.level,
            animatedNumbers: true,
            contextGaugeStyle: 'gauge',
            osReduceMotion: false,
            isWeb: false,
        }),
    };
});

import { InstrumentCard } from './InstrumentCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(element: React.ReactElement): ReactTestRenderer {
    let tree: ReactTestRenderer | null = null;
    act(() => {
        tree = create(element);
    });
    if (tree === null) throw new Error('InstrumentCard test renderer did not mount');
    return tree;
}

function surfaceStyleOf(tree: ReactTestRenderer): any {
    const host = tree.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'card')[0]!;
    const styles = Array.isArray(host.props.style) ? host.props.style.flat() : [host.props.style];
    return styles.find((s: any) => s && typeof s === 'object' && 'backgroundColor' in s);
}

function hasCastShadow(style: any): boolean {
    return style.boxShadow !== undefined || style.shadowOpacity !== undefined || style.elevation !== undefined;
}

describe('instrument InstrumentCard', () => {
    beforeEach(() => {
        motionState.level = 'full';
    });

    it('tile variant (default) adopts the canonical flat grouped-surface chrome — no competing drop shadow or bespoke radius (D-R4-1)', () => {
        // Light theme (test stub): border.surface + effect.surfaceHighlight are
        // transparent, so the canonical grouped surface (ItemGroup) is flat —
        // NO hairline, NO cast shadow. InstrumentCard's tile must match exactly
        // so it does not read as a different tile than every other in the app.
        const tree = render(<InstrumentCard testID="card"><React.Fragment>content</React.Fragment></InstrumentCard>);
        const surface = surfaceStyleOf(tree);
        expect(surface.backgroundColor).toBe('#ffffff');
        expect(surface.borderWidth).toBe(0);
        expect(hasCastShadow(surface)).toBe(false);
        // Canonical grouped-surface radius (ItemGroup: 10 on iOS, 16 elsewhere) —
        // never a bespoke 12/20/24.
        expect([10, 16]).toContain(surface.borderRadius);
    });

    it('tile variant never paints the specular highlight (ItemGroup has none)', () => {
        const tile = render(<InstrumentCard testID="card"><React.Fragment /></InstrumentCard>);
        expect(tile.root.findAll((n) => String(n.type) === 'LinearGradient')).toHaveLength(0);
    });

    it('popover variant is an elevated floating surface — soft cast shadow + hairline border, its own radius', () => {
        const tree = render(<InstrumentCard testID="card" variant="popover"><React.Fragment /></InstrumentCard>);
        const surface = surfaceStyleOf(tree);
        expect(surface.borderColor).toMatch(/^rgba\(.*0\.4\)$/);
        expect(surface.borderWidth).toBe(1); // hairlineWidth = 1 in the RN test stub
        expect(hasCastShadow(surface)).toBe(true);
        expect(surface.borderRadius).toBe(12);
    });

    it('popover shows the specular highlight only at full effects level', () => {
        const withEffects = render(<InstrumentCard testID="card" variant="popover"><React.Fragment /></InstrumentCard>);
        expect(withEffects.root.findAll((n) => String(n.type) === 'LinearGradient')).toHaveLength(1);

        motionState.level = 'subtle';
        const withoutEffects = render(<InstrumentCard testID="card" variant="popover"><React.Fragment /></InstrumentCard>);
        expect(withoutEffects.root.findAll((n) => String(n.type) === 'LinearGradient')).toHaveLength(0);
    });
});
