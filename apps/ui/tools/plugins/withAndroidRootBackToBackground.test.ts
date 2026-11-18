import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../../plugins/withAndroidRootBackToBackground.js');
const template = readFileSync(join(__dirname, 'fixtures/expo55/MainActivity.kt'), 'utf8');
const apply = plugin.applyRootBackToBackground as (contents: string) => string;

function backMethod(contents: string): string {
    return contents.match(/override fun invokeDefaultOnBackPressed\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
}

describe('withAndroidRootBackToBackground', () => {
    it('moves the root task to the background on every Android version instead of finishing it', () => {
        const method = backMethod(apply(template));
        // React Native calls this only when JavaScript did not handle BACK, i.e. at the navigation root.
        expect(method).toContain('if (!moveTaskToBack(false))');
        expect(method).not.toMatch(/Build\.VERSION/);
        // A non-root Activity still finishes the default way.
        expect(method.match(/super\.invokeDefaultOnBackPressed\(\)/g)).toHaveLength(1);
    });

    it('is idempotent and refuses an unrecognized template', () => {
        const once = apply(template);
        expect(apply(once)).toBe(once);
        expect(() => apply(template.replace(/override fun invokeDefaultOnBackPressed[\s\S]*?\n {2}\}/, ''))).toThrow();
    });
});
