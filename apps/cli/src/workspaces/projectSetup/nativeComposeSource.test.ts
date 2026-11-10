import { describe, expect, it } from 'vitest';
import { parseNativeComposeSource } from './nativeComposeSource';

describe('stored Compose source syntax', () => {
    it('preserves YAML merge semantics at the native source entry point', async () => {
        const source = await parseNativeComposeSource('x-base: &base\n  image: app:1\nservices:\n  app:\n    <<: *base\n    environment: ["MODE=production"]\n');
        expect(source.services).toEqual({ app: { image: 'app:1', environment: ['MODE=production'] } });
    });

    it.each(['[', '[]', 'null', '42'])('retains invalid_request for invalid or non-object source %s', async document => {
        await expect(parseNativeComposeSource(document)).rejects.toMatchObject({ code: 'invalid_request' });
    });
});
