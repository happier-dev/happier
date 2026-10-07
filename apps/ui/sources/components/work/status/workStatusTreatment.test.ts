import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

import { WORK_STATUS_PILL_VARIANT } from './resolveWorkStatusTone';
import { lightTheme } from '@/theme';

import { projectWorkColors, workStatusGlyphColor, workStatusSurfaceStyle, workStatusWordStyle } from './workStatusTreatment';

describe('work status treatment', () => {
    it('keeps healthy work neutral: no ring, no tint, a quiet word', () => {
        expect(workStatusSurfaceStyle('neutral')).toBeNull();
        expect(workStatusWordStyle('neutral')).toBeNull();
        expect(WORK_STATUS_PILL_VARIANT.neutral).toBe('neutral');
    });

    it('marks needs-you and trouble with a full ring, never a coloured left edge', () => {
        for (const tone of ['attention', 'danger'] as const) {
            const surface = workStatusSurfaceStyle(tone) as Record<string, unknown> | null;
            expect(surface).not.toBeNull();
            for (const edge of ['borderLeftWidth', 'borderStartWidth', 'borderLeftColor', 'borderStartColor']) {
                expect(surface).not.toHaveProperty(edge);
            }
            expect(workStatusWordStyle(tone)).not.toBeNull();
        }
    });

    it('draws needs-you in the Brand attention amber (not the system warning orange), trouble in rose, healthy in the ink', () => {
        const colors = lightTheme.colors;
        expect(colors.state.attention.foreground).not.toBe(colors.state.warning.foreground);
        expect(workStatusGlyphColor(colors, 'attention')).toBe(colors.state.attention.foreground);
        expect(projectWorkColors(lightTheme).attention.foreground).toBe(colors.state.attention.foreground);
        expect(workStatusGlyphColor(colors, 'danger')).toBe(colors.state.danger.foreground);
        expect(workStatusGlyphColor(colors, 'neutral')).toBe(colors.text.secondary);
    });
});
