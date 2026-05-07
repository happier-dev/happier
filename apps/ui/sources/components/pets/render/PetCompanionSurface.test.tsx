import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const platformState = vi.hoisted(() => ({
    os: 'web',
}));

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native')>();
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            get OS() {
                return platformState.os;
            },
        },
    };
});

describe('PetCompanionSurface', () => {
    afterEach(() => {
        standardCleanup();
        platformState.os = 'web';
        vi.unstubAllGlobals();
    });

    it('binds web mouse drags directly to the mascot DOM target', async () => {
        const onMouseDown = vi.fn();
        const element = Object.assign(new EventTarget(), {
            closest: (selector: string) => selector.includes('data-pet-mascot') ? element : null,
        });
        vi.stubGlobal('document', {
            querySelector: (selector: string) =>
                selector.includes('pet-companion-hitbox') ? element : null,
        });
        const { PetCompanionSurface } = await import('./PetCompanionSurface');

        const screen = await renderScreen(
            <PetCompanionSurface
                state="idle"
                spriteTestID="pet-companion-sprite"
                hitboxTestID="pet-companion-hitbox"
                pointerHandlers={{ onMouseDown }}
            />,
        );

        expect(screen.findByTestId('pet-companion-hitbox')?.props['data-tauri-drag-region']).toBe('true');
        expect(screen.findByTestId('pet-companion-hitbox')?.props.dataSet).toEqual(expect.objectContaining({
            tauriDragRegion: 'true',
        }));

        element.dispatchEvent(Object.assign(new Event('mousedown'), { button: 0 }));

        expect(onMouseDown).toHaveBeenCalledTimes(1);
    });
});
