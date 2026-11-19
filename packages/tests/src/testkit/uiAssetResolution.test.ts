// @vitest-environment jsdom
import { expect, it } from 'vitest';

it('loads a production UI asset through the composed test setup', () => {
    // The shared setup resolves Metro asset aliases at require time.
    const avatarGradientAsset = '@/assets/images/gradients/01.png';
    expect(require(avatarGradientAsset)).toBeDefined();
});

it('passes cancellation from the composed UI environment to Node fetch', async () => {
    const reason = new Error('Request cancelled before transport');
    await expect(fetch('http://127.0.0.1', { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    const controller = new AbortController();
    controller.abort(reason);
    await expect(fetch('http://127.0.0.1', { signal: controller.signal })).rejects.toBe(reason);
});
