import { describe, expect, it } from 'vitest';

import { redirectSystemPath } from '@/app/+native-intent';

describe('native system URL routing', () => {
    it.each([true, false])('normalizes account-connect URLs for initial=%s', (initial) => {
        expect(redirectSystemPath({ path: 'happier:///account?abc+123/=', initial })).toBe(
            '/account?accountConnectKey=abc%2B123%2F%3D',
        );
    });

    it('leaves unrelated system paths unchanged', () => {
        expect(redirectSystemPath({ path: 'happier:///terminal?key=abc123', initial: true })).toBe(
            'happier:///terminal?key=abc123',
        );
    });
});
