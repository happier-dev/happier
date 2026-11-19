// @vitest-environment jsdom
import { expect, it } from 'vitest';

it('loads a production UI asset through the composed test setup', () => {
    // The shared setup resolves Metro asset aliases at require time.
    const avatarGradientAsset = '@/assets/images/gradients/01.png';
    expect(require(avatarGradientAsset)).toBeDefined();
});
