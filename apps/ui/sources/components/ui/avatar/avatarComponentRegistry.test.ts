import { describe, expect, it } from 'vitest';

import { getGeneratedAvatarComponentForStyle } from './avatarComponentRegistry';

describe('avatarComponentRegistry', () => {
    it('routes PhotoGradient styles through their own generated avatar component', () => {
        const Component = getGeneratedAvatarComponentForStyle('photoGradientDiagonal');

        expect(Component).toBeDefined();
        expect(Component.displayName ?? Component.name).toBe('AvatarPhotoGradient');
    });
});
